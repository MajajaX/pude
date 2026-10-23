import { describe, expect, it } from "vitest";
import { projectAfterClose, projectTabLabel, projectTabTitle, reorderProjects } from "./project-tabs";

describe("project tab navigation", () => {
  it("distinguishes equal project names and preserves Files", () => {
    const projects = [{ workspace: "/client/editor" }, { workspace: "/server/editor" }, { workspace: "" }];
    expect(projects.map((project) => projectTabLabel(project, projects))).toEqual(["editor — client", "editor — server", "Files"]);
  });

  it("names workspaces after their file or first folder and lists every folder in the tooltip", () => {
    const saved = { workspace: "/work/web", additionalFolders: ["/work/api"], workspaceFile: "/work/team.pdw" };
    const unsaved = { workspace: "/work/web", additionalFolders: ["/work/api", "/work/docs"] };
    expect(projectTabLabel(saved, [saved, unsaved])).toBe("team");
    expect(projectTabLabel(unsaved, [saved, unsaved])).toBe("web +2");
    expect(projectTabTitle(saved)).toBe("/work/team.pdw\n/work/web\n/work/api");
    expect(projectTabTitle({ workspace: "" })).toBe("Files");
  });

  it("chooses the right neighbor, then the left, and leaves background closures alone", () => {
    expect(projectAfterClose(["a", "b", "c"], "b", "b")).toBe("c");
    expect(projectAfterClose(["a", "b", "c"], "c", "c")).toBe("b");
    expect(projectAfterClose(["a"], "a", "a")).toBeUndefined();
    expect(projectAfterClose(["a", "b"], "a", "b")).toBe("a");
  });

  it("reorders stable project IDs without changing selection or accepting foreign IDs", () => {
    const projects = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(reorderProjects(projects, "c", "a").map((project) => project.id)).toEqual(["c", "a", "b"]);
    expect(reorderProjects(projects, "foreign-window", "a")).toEqual(projects);
    expect(projects.map((project) => project.id)).toEqual(["a", "b", "c"]);
  });
});
