/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import Markdown from "./markdown.tsx";

afterEach(cleanup);

function md(text: string) {
  return render(<Markdown text={text} />).container;
}

describe("markdown-lite: the three marks", () => {
  it("renders **bold** as a strong element", () => {
    const c = md("task complete: **otter**");
    expect(c.querySelector("strong")?.textContent).toBe("otter");
    expect(c.textContent).toBe("task complete: otter");
  });

  it("renders *italic* as an em element", () => {
    expect(md("a *quiet* word").querySelector("em")?.textContent).toBe("quiet");
  });

  it("renders _italic_ as an em element", () => {
    expect(md("a _quiet_ word").querySelector("em")?.textContent).toBe("quiet");
  });

  it("renders `inline code` as a code element", () => {
    const code = md("run `npm test` now").querySelector("code");
    expect(code?.textContent).toBe("npm test");
    expect(code?.className).toBe("md-code");
  });

  it("handles several marks in one run", () => {
    const c = md("**bold** then *em* then `code`");
    expect(c.querySelectorAll("strong")).toHaveLength(1);
    expect(c.querySelectorAll("em")).toHaveLength(1);
    expect(c.querySelectorAll("code")).toHaveLength(1);
    expect(c.textContent).toBe("bold then em then code");
  });

  it("keeps plain text plain", () => {
    const c = md("nothing to see here");
    expect(c.textContent).toBe("nothing to see here");
    expect(c.querySelector("strong")).toBeNull();
  });

  it("renders the empty string as nothing", () => {
    expect(md("").textContent).toBe("");
  });
});

describe("markdown-lite: nesting and adjacency", () => {
  it("nests emphasis inside bold", () => {
    const c = md("**bold *and italic* here**");
    const strong = c.querySelector("strong");
    expect(strong?.textContent).toBe("bold and italic here");
    expect(strong?.querySelector("em")?.textContent).toBe("and italic");
  });

  it("nests code inside bold without parsing marks inside the code", () => {
    const c = md("**run `a**b` now**");
    expect(c.querySelector("code")?.textContent).toBe("a**b");
    expect(c.querySelector("strong")?.textContent).toBe("run a**b now");
  });

  it("does not parse marks inside a code span", () => {
    const c = md("`**not bold**` and `_not em_`");
    expect(c.querySelector("strong")).toBeNull();
    expect(c.querySelector("em")).toBeNull();
    expect(Array.from(c.querySelectorAll("code")).map((e) => e.textContent)).toEqual([
      "**not bold**",
      "_not em_",
    ]);
  });

  it("does not treat the ** of a bold run as italic markers", () => {
    const c = md("**a** and **b**");
    expect(Array.from(c.querySelectorAll("strong")).map((e) => e.textContent)).toEqual(["a", "b"]);
    expect(c.querySelector("em")).toBeNull();
    expect(c.textContent).toBe("a and b");
  });

  it("handles bold flush against neighbouring words", () => {
    const c = md("x**y**z");
    expect(c.querySelector("strong")?.textContent).toBe("y");
    expect(c.textContent).toBe("xyz");
  });

  it("leaves an unclosed ** as literal text", () => {
    const c = md("**not closed");
    expect(c.querySelector("strong")).toBeNull();
    expect(c.textContent).toBe("**not closed");
  });

  it("leaves an unclosed backtick as literal text", () => {
    const c = md("a ` b");
    expect(c.querySelector("code")).toBeNull();
    expect(c.textContent).toBe("a ` b");
  });

  it("does not emphasise across whitespace-bounded asterisks", () => {
    const c = md("2 * 3 * 4");
    expect(c.querySelector("em")).toBeNull();
    expect(c.textContent).toBe("2 * 3 * 4");
  });

  it("leaves underscores inside identifiers alone", () => {
    const c = md("call snake_case_name twice");
    expect(c.querySelector("em")).toBeNull();
    expect(c.textContent).toBe("call snake_case_name twice");
  });

  it("does not emphasise an empty run", () => {
    expect(md("**** and ``").textContent).toBe("**** and ``");
  });

  it("does not lose marks that span an ordinary sentence", () => {
    const c = md("The **A2A** spec and the *NATS* one both use `subjects`.");
    expect(c.textContent).toBe("The A2A spec and the NATS one both use subjects.");
  });
});

describe("markdown-lite: raw markup stays inert", () => {
  it("renders HTML tags in the source as visible text, not elements", () => {
    const c = md("<b>hi</b> <script>alert(1)</script>");
    expect(c.querySelector("b")).toBeNull();
    expect(c.querySelector("script")).toBeNull();
    expect(c.textContent).toBe("<b>hi</b> <script>alert(1)</script>");
  });

  it("keeps HTML inside a bold run as text", () => {
    const c = md("**<img src=x onerror=1>**");
    expect(c.querySelector("img")).toBeNull();
    expect(c.querySelector("strong")?.textContent).toBe("<img src=x onerror=1>");
  });

  it("does not decode entities", () => {
    expect(md("a &amp; b &lt;c&gt;").textContent).toBe("a &amp; b &lt;c&gt;");
  });

  it("produces only strong, em and code elements", () => {
    const c = md("**a** *b* `c` <u>d</u>");
    const tags = Array.from(c.querySelectorAll("*")).map((e) => e.tagName.toLowerCase());
    expect(new Set(tags)).toEqual(new Set(["strong", "em", "code"]));
  });
});
