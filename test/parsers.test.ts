import { describe, expect, it, vi } from "vitest";
import { parseVttContent } from "@/lib/evidence/parsers/vtt";
import { parseCsvContent } from "@/lib/evidence/parsers/csv";
import { parseEvidenceFile } from "@/lib/evidence/parsers";

/*
  Parser unit tests. Pure-helper tests use the exported sync
  `parseXContent` functions; the File-based wrappers are exercised
  via `parseEvidenceFile` with synthetic File objects.

  PDF is covered only at the dispatcher level — pdf-parse opens a
  sandbox that's slow + noisy under vitest. Integration tests on
  real PDFs ride on the upload Route Handler.
*/

describe("parseVttContent", () => {
  it("returns empty string for empty input", () => {
    expect(parseVttContent("")).toBe("");
  });

  it("strips the WEBVTT header + timing lines", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.500
Hello world

00:00:04.000 --> 00:00:06.000
Goodbye world`;
    expect(parseVttContent(vtt)).toBe("Hello world\nGoodbye world");
  });

  it("extracts speaker from <v Speaker> tags", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
<v Alice>I can't find the export button.

00:00:04.000 --> 00:00:06.000
<v Bob>Yeah, same issue on my end.`;
    const out = parseVttContent(vtt);
    expect(out).toContain("Alice: I can't find the export button.");
    expect(out).toContain("Bob: Yeah, same issue on my end.");
  });

  it("handles CRLF line endings", () => {
    const vtt = "WEBVTT\r\n\r\n00:00:01.000 --> 00:00:03.000\r\nHello\r\n";
    expect(parseVttContent(vtt)).toBe("Hello");
  });

  it("skips NOTE and STYLE blocks", () => {
    const vtt = `WEBVTT

NOTE This is a note

00:00:01.000 --> 00:00:03.000
Real content`;
    expect(parseVttContent(vtt)).toBe("Real content");
  });

  it("skips cue identifiers on their own line", () => {
    const vtt = `WEBVTT

cue-1
00:00:01.000 --> 00:00:03.000
Hello`;
    expect(parseVttContent(vtt)).toBe("Hello");
  });

  it("strips style tags but keeps content", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
This is <b>bold</b> and <i>italic</i>`;
    expect(parseVttContent(vtt)).toBe("This is bold and italic");
  });
});

describe("parseCsvContent", () => {
  it("returns empty for empty input", () => {
    expect(parseCsvContent("")).toBe("");
  });

  it("formats a single header row + data row", () => {
    const csv = `Ticket,Subject,Priority
T-123,Export fails,High`;
    const out = parseCsvContent(csv);
    expect(out).toContain("Ticket: T-123");
    expect(out).toContain("Subject: Export fails");
    expect(out).toContain("Priority: High");
  });

  it("separates multiple rows with a blank line", () => {
    const csv = `Name,Role
Alice,PM
Bob,Eng`;
    const out = parseCsvContent(csv);
    const blocks = out.split("\n\n");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain("Alice");
    expect(blocks[1]).toContain("Bob");
  });

  it("handles quoted values with commas inside", () => {
    const csv = `Name,Description
Alice,"Says hello, then leaves"`;
    const out = parseCsvContent(csv);
    expect(out).toContain("Description: Says hello, then leaves");
  });

  it("uses Column N fallback when no header is detected", () => {
    const csv = `1,2,3
4,5,6`;
    const out = parseCsvContent(csv);
    // All rows are numeric, so looksLikeHeader returns false
    expect(out).toContain("Column 1:");
  });

  it("drops empty cells silently", () => {
    const csv = `A,B,C
1,,3`;
    const out = parseCsvContent(csv);
    expect(out).toContain("A: 1");
    expect(out).toContain("C: 3");
    expect(out).not.toContain("B:");
  });

  it("parses TSV when the extension is .tsv", () => {
    const tsv = "A\tB\nhello\tworld";
    const out = parseCsvContent(tsv, "x.tsv");
    expect(out).toContain("A: hello");
    expect(out).toContain("B: world");
  });
});

describe("parseEvidenceFile dispatcher", () => {
  function mkFile(name: string, content: string, type = ""): File {
    return new File([content], name, { type });
  }

  it("routes .txt to the text parser", async () => {
    const f = mkFile("notes.txt", "hello world", "text/plain");
    const r = await parseEvidenceFile(f);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("hello world");
  });

  it("routes .vtt to the VTT parser", async () => {
    const vtt =
      "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Alice>Hi there";
    const f = mkFile("call.vtt", vtt, "text/vtt");
    const r = await parseEvidenceFile(f);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain("Alice: Hi there");
  });

  it("routes .csv to the CSV parser with Key: value formatting", async () => {
    const csv = "Name,Role\nAlice,PM";
    const f = mkFile("team.csv", csv, "text/csv");
    const r = await parseEvidenceFile(f);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain("Name: Alice");
      expect(r.text).toContain("Role: PM");
    }
  });

  it("rejects unknown formats with a typed unsupported error", async () => {
    const f = mkFile("image.bin", "xxx", "application/octet-stream");
    const r = await parseEvidenceFile(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unsupported");
  });

  it("rejects empty text files as empty, not unsupported", async () => {
    const f = mkFile("blank.txt", "   \n\n", "text/plain");
    const r = await parseEvidenceFile(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("empty");
  });

  // Regression: a static `import { PDFParse } from "pdf-parse"` at the
  // top of pdf.ts crashed the upload route module on load (pdfjs-dist
  // worker init failure), so every upload — including .txt — returned
  // an HTML 500 page. With the deferred import, a broken pdf-parse
  // must NOT poison non-PDF parsing.
  it("parses .txt files even when pdf-parse fails to load", async () => {
    vi.resetModules();
    vi.doMock("pdf-parse", () => {
      throw new Error("simulated pdfjs-dist worker init failure");
    });
    const { parseEvidenceFile: freshParse } = await import(
      "@/lib/evidence/parsers"
    );
    const f = mkFile("notes.txt", "hello world", "text/plain");
    const r = await freshParse(f);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("hello world");
    vi.doUnmock("pdf-parse");
    vi.resetModules();
  });

  it("returns a typed parse_failed error when pdf-parse can't load on a PDF", async () => {
    vi.resetModules();
    vi.doMock("pdf-parse", () => {
      throw new Error("simulated pdfjs-dist worker init failure");
    });
    const { parseEvidenceFile: freshParse } = await import(
      "@/lib/evidence/parsers"
    );
    const f = mkFile("doc.pdf", "%PDF-1.4", "application/pdf");
    const r = await freshParse(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("parse_failed");
    vi.doUnmock("pdf-parse");
    vi.resetModules();
  });
});
