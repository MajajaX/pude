import { describe, expect, it } from "vitest";
import { dotenvAppendEdit, dotenvDeleteEdit, dotenvKeyEdit, dotenvLine, dotenvValueEdit, encodeDotenvValue, parseDotenv } from "./dotenv";
import type { DotenvVariable } from "./dotenv";

const applyEdit = (text: string, edit: { from: number; to: number; insert: string }) => text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
const variables = (text: string) => parseDotenv(text).filter((entry): entry is DotenvVariable => entry.kind === "variable");

describe("dotenv parsing", () => {
  it("reads plain, quoted, exported and commented variables", () => {
    const text = "# Database\nexport DB_HOST = localhost # local only\nDB_PASS='p@ss word'\nGREETING=\"hi \\\"you\\\"\\nbye\"\nURL=http://x.test/#top\nEMPTY=\n";
    const entries = parseDotenv(text);
    expect(entries[0]).toMatchObject({ kind: "comment", text: "Database" });
    expect(variables(text).map(({ key, value, quote }) => ({ key, value, quote }))).toEqual([
      { key: "DB_HOST", value: "localhost", quote: "" },
      { key: "DB_PASS", value: "p@ss word", quote: "'" },
      { key: "GREETING", value: "hi \"you\"\nbye", quote: "\"" },
      { key: "URL", value: "http://x.test/#top", quote: "" },
      { key: "EMPTY", value: "", quote: "" },
    ]);
  });

  it("keeps multi-line quoted values as one variable", () => {
    const text = "KEY=\"line one\nline two\"\nNEXT=1";
    const [key, next] = variables(text);
    expect(key).toMatchObject({ key: "KEY", value: "line one\nline two" });
    expect(next).toMatchObject({ key: "NEXT", value: "1" });
  });

  it("marks repeated keys as duplicates", () => {
    expect(variables("A=1\nB=2\nA=3").map((variable) => variable.duplicate)).toEqual([true, false, true]);
  });

  it("copies the KEY=value text without export or comment", () => {
    const text = "export TOKEN=\"abc\" # secret";
    expect(dotenvLine(text, variables(text)[0])).toBe("TOKEN=\"abc\"");
  });
});

describe("dotenv editing", () => {
  it("edits the key and value in place", () => {
    const text = "export DB_HOST = localhost # local only\n";
    const [variable] = variables(text);
    expect(applyEdit(text, dotenvKeyEdit(variable, "DB HOST="))).toBe("export DBHOST = localhost # local only\n");
    expect(applyEdit(text, dotenvValueEdit(variable, "my host"))).toBe("export DB_HOST = my host # local only\n");
    expect(applyEdit(text, dotenvValueEdit(variable, "my host "))).toBe("export DB_HOST = \"my host \" # local only\n");
  });

  it("round-trips any value through encoding", () => {
    for (const quote of ["", "\"", "'", "`"] as const) {
      for (const value of ["plain", " padded ", "a # b", "#x", "it's", "say \"hi\"", "two\nlines", "back\\slash\\", "\\n literal", ""]) {
        const text = `KEY=${encodeDotenvValue(value, quote)}\n`;
        expect(variables(text)[0].value).toBe(value);
      }
    }
  });

  it("deletes a variable's lines", () => {
    const text = "A=1\nB=2";
    const [a, b] = parseDotenv(text);
    expect(applyEdit(text, dotenvDeleteEdit(text, a))).toBe("B=2");
    expect(applyEdit(text, dotenvDeleteEdit(text, b))).toBe("A=1");
  });

  it("appends a new variable on its own line", () => {
    expect(applyEdit("A=1", dotenvAppendEdit("A=1", "B", "two words ")!)).toBe("A=1\nB=\"two words \"");
    expect(applyEdit("A=1\n", dotenvAppendEdit("A=1\n", "B", "")!)).toBe("A=1\nB=\n");
  });

  it("does not append a variable without a name", () => {
    expect(dotenvAppendEdit("A=1", "", "x")).toBeUndefined();
    expect(dotenvAppendEdit("A=1", " = ", "x")).toBeUndefined();
    expect(dotenvAppendEdit("", "#", "x")).toBeUndefined();
    expect(applyEdit("", dotenvAppendEdit("", "B C", "x")!)).toBe("BC=x\n");
  });
});

describe("dotenv value edits keep the original representation", () => {
  const editValue = (text: string, value: string, index = 0) => applyEdit(text, dotenvValueEdit(variables(text)[index], value));

  it("leaves untouched lines and unchanged values byte-identical", () => {
    const text = "# c\r\nexport A='$HOME\\n' # note\r\nB=\"x\\ny\"\r\nC=`t`\r\nD=plain\r\n";
    for (const [index, variable] of variables(text).entries()) expect(editValue(text, variable.value, index)).toBe(text);
  });

  it("keeps physical newlines inside a multi-line double-quoted value", () => {
    const text = "KEY=\"one\ntwo\"\nNEXT=1\n";
    expect(variables(text)[0].multiline).toBe(true);
    expect(editValue(text, "one\ntwo\nthree")).toBe("KEY=\"one\ntwo\nthree\"\nNEXT=1\n");
    expect(editValue(text, "say \"hi\"\nbye")).toBe("KEY=\"say \\\"hi\\\"\nbye\"\nNEXT=1\n");
  });

  it("keeps escaped newlines in a single-line double-quoted value", () => {
    const text = "KEY=\"one\\ntwo\"\n";
    expect(variables(text)[0].multiline).toBe(false);
    expect(editValue(text, "one\ntwo\nthree")).toBe("KEY=\"one\\ntwo\\nthree\"\n");
  });

  it("keeps single quotes with literal $ and backslash-n", () => {
    const text = "A='cost $5 \\n'\n";
    expect(editValue(text, "cost $6 \\n")).toBe("A='cost $6 \\n'\n");
    expect(editValue(text, "it's")).toBe("A=\"it's\"\n");
  });

  it("keeps physical newlines inside single quotes and backticks", () => {
    expect(editValue("A='a\nb'\n", "a\nb\nc")).toBe("A='a\nb\nc'\n");
    expect(editValue("A=`x`\n", "y\nz")).toBe("A=`y\nz`\n");
    expect(editValue("A=`x`\n", "it's `ticked`")).toBe("A=\"it's `ticked`\"\n");
  });

  it("keeps the export prefix and inline comment", () => {
    expect(editValue("export A='x' # why\n", "y")).toBe("export A='y' # why\n");
    expect(editValue("export A=\"x\" # why\n", "y z")).toBe("export A=\"y z\" # why\n");
    expect(editValue("export A=x # why\n", "y")).toBe("export A=y # why\n");
  });

  it("keeps CRLF line endings around an edited value", () => {
    expect(editValue("A=x\r\nB=y\r\n", "z")).toBe("A=z\r\nB=y\r\n");
    expect(editValue("A='x'\r\nB=y\r\n", "z")).toBe("A='z'\r\nB=y\r\n");
    expect(editValue("A=\"x\r\ny\"\r\nB=y\r\n", "p\r\nq")).toBe("A=\"p\r\nq\"\r\nB=y\r\n");
  });
});
