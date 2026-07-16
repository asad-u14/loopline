import { test } from "node:test";
import assert from "node:assert/strict";
import { mdToHtml, escapeHtml } from "../src/util/markdown";

test("escapeHtml: escapes angle brackets and ampersands", () => {
  assert.equal(escapeHtml('<script>&"'), "&lt;script&gt;&amp;\"");
});

test("mdToHtml: escapes HTML in plain text (no injection)", () => {
  const html = mdToHtml("<img src=x onerror=alert(1)>");
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test("mdToHtml: headings", () => {
  assert.match(mdToHtml("## Goal"), /<h2>Goal<\/h2>/);
});

test("mdToHtml: bullet list", () => {
  const html = mdToHtml("- one\n- two");
  assert.match(html, /<ul>/);
  assert.match(html, /<li>one<\/li>/);
  assert.match(html, /<li>two<\/li>/);
});

test("mdToHtml: numbered list", () => {
  const html = mdToHtml("1. first\n2. second");
  assert.match(html, /<ol>/);
  assert.match(html, /<li>first<\/li>/);
});

test("mdToHtml: bold and inline code", () => {
  assert.match(mdToHtml("this is **bold** and `code`"), /<strong>bold<\/strong>.*<code>code<\/code>/);
});

test("mdToHtml: safe link", () => {
  const html = mdToHtml("see [docs](https://example.com/x)");
  assert.match(html, /<a href="https:\/\/example\.com\/x">docs<\/a>/);
});

test("mdToHtml: fenced code block is escaped", () => {
  const html = mdToHtml("```\n<b>hi</b>\n```");
  assert.match(html, /<pre><code>&lt;b&gt;hi&lt;\/b&gt;<\/code><\/pre>/);
});

test("mdToHtml: paragraphs separated by blank lines", () => {
  const html = mdToHtml("para one\n\npara two");
  assert.match(html, /<p>para one<\/p>/);
  assert.match(html, /<p>para two<\/p>/);
});
