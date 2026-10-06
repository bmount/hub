import { describe, expect, it } from "vitest";
import { parseBody, parseRefText, stripCode } from "../src/chat/grammar";

const SID = "01JB2Q3R4S5T6V7W8X9YZABCDE";

describe("ref and mention grammar", () => {
  it("finds every phase 1 ref kind, in body order, with and without prefixes", () => {
    const body = `see site#k7q2 and site@3f9a2c1, ticket:web#ab12 commit:web@0123456789abcdef session:${SID} msg:general/412 msg:${SID}`;
    expect(parseBody(body).refs.map((r) => [r.kind, r.text])).toEqual([
      ["ticket", "site#k7q2"], ["commit", "site@3f9a2c1"], ["ticket", "web#ab12"], ["commit", "web@0123456789abcdef"],
      ["session", `session:${SID}`], ["msg", "msg:general/412"], ["msg", `msg:${SID}`],
    ]);
    expect(parseBody("msg:general/412").refs[0]).toEqual({ kind: "msg", text: "msg:general/412", channel: "general", seq: 412, msg_id: null });
    expect(parseBody("site@3f9a2c1").refs[0]).toEqual({ kind: "commit", text: "site@3f9a2c1", repo: "site", oid: "3f9a2c1" });
  });

  it("strips fenced blocks in CRLF and CR bodies, then reads what follows", () => {
    for (const nl of ["\r\n", "\r"]) {
      const body = ["```", "site#k7q2 @ghost", "```", "hello @scout and web#ab12"].join(nl);
      const p = parseBody(body);
      expect(p.handles).toEqual(["scout"]);
      expect(p.refs.map((r) => r.text)).toEqual(["web#ab12"]);
    }
  });

  it("ignores code spans, fenced blocks (closed or not), addresses, short prefixes, and bare numbers", () => {
    for (const body of [
      "`site#k7q2` and ``site@3f9a2c1``", "```\nsite@3f9a2c1 @scout\nweb#ab12\n```", "~~~ts\nweb#ab12\n~~~", "mail dev@example.com",
      "site@3f9a2c", "x@deadbeef0.com", "see #412", "```\nsite#k7q2 @scout\nnever closed",
    ]) {
      const p = parseBody(body);
      expect({ body, refs: p.refs, handles: p.handles }).toEqual({ body, refs: [], handles: [] });
    }
    expect(parseBody("```\ncode\n```\nafter site#k7q2").refs.map((r) => r.text)).toEqual(["site#k7q2"]);
  });

  it("collects mentions once, separates broadcasts, and never reads addresses", () => {
    expect(parseBody("@lead and @scout, @scout again; not dev@example.com; @here @channel.\n@tidy.").handles).toEqual(["lead", "scout", "tidy"]);
    expect(parseBody("@here @channel @all @everyone").broadcasts).toEqual(["here", "channel", "all", "everyone"]);
    expect(parseBody("@Lead @x @a-very-long-handle-that-is-over-24").handles).toEqual([]);
  });

  it("blanks code without moving positions", () => {
    expect(stripCode("a `b` c").length).toBe("a `b` c".length);
    expect(stripCode("a `b` c")).not.toContain("b");
    expect(stripCode("```\nx\n```\ny").split("\n").length).toBe(4);
  });

  it("parses an explicit ref only when the whole key is one ref of that kind", () => {
    expect(parseRefText("ticket", "site#k7q2")).toMatchObject({ kind: "ticket", repo: "site", ticket: "k7q2" });
    expect(parseRefText("commit", "site@3f9a2c1")).toMatchObject({ kind: "commit", repo: "site", oid: "3f9a2c1" });
    expect(parseRefText("session", SID)).toMatchObject({ kind: "session", session_id: SID });
    expect(parseRefText("msg", "general/7")).toMatchObject({ kind: "msg", channel: "general", seq: 7 });
    expect(parseRefText("commit", "site@3f9a2c1 extra")).toBeNull();
    expect(parseRefText("ticket", "site@3f9a2c1")).toBeNull();
    expect(parseRefText("project", "research/site")).toBeNull();
  });
});
