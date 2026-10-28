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
    expect(applyEdit("A=1", dotenvAppendEdit("A=1", "B", "two words "))).toBe("A=1\nB=\"two words \"");
    expect(applyEdit("A=1\n", dotenvAppendEdit("A=1\n", "B", ""))).toBe("A=1\nB=\n");
    expect(applyEdit("", dotenvAppendEdit("", "", "x"))).toBe("=x\n");
  });
});
