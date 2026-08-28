import assert from "node:assert/strict";
import test from "node:test";
import { extractWeixinUrls, isBlockedWeixinPage, parseWeixinHtml, stripWeixinUrls } from "./weixin-article.js";

test("extracts and strips weixin article urls", () => {
  const text = "请以这篇微信公众号文章为材料学习。\n\n微信公众号文章：https://mp.weixin.qq.com/s/abcd1234";
  assert.deepEqual(extractWeixinUrls(text), ["https://mp.weixin.qq.com/s/abcd1234"]);
  assert.equal(stripWeixinUrls(text), "请以这篇微信公众号文章为材料学习。");
  assert.deepEqual(extractWeixinUrls("今天天气怎么样"), []);
});

test("parses weixin article title and js_content", () => {
  const html = `
    <html>
      <head><meta property="og:title" content="定投的底层逻辑"></head>
      <body>
        <h1 id="activity-name">定投的底层逻辑</h1>
        <div id="js_content">
          <p>定投不是择时。</p>
          <div><img data-src="https://example.com/a.png"></div>
          <p>贵不贵要看估值分位数。</p>
        </div>
      </body>
    </html>
  `;
  const parsed = parseWeixinHtml(html);
  assert.equal(parsed.title, "定投的底层逻辑");
  assert.match(parsed.markdown, /定投不是择时/);
  assert.match(parsed.markdown, /估值分位数/);
  assert.match(parsed.markdown, /https:\/\/example.com\/a.png/);
});

test("rejects weixin verification pages as article content", () => {
  assert.equal(isBlockedWeixinPage("## 环境异常\n当前环境异常，完成验证后即可继续访问。"), true);
  assert.equal(isBlockedWeixinPage("定投不是择时。贵不贵要看估值分位数。"), false);
});

test("reads nested weixin title tags", () => {
  const html = `
    <meta property="og:title" content="拥有对自己命运的掌控权~">
    <h1 id="activity-name"><span class="js_title_inner">拥有对自己命运的掌控权~</span></h1>
    <div id="js_content"><p>我之前建议过，多靠近条件好、高能量的群体。</p></div>
  `;
  const parsed = parseWeixinHtml(html);
  assert.equal(parsed.title, "拥有对自己命运的掌控权~");
  assert.match(parsed.markdown, /高能量/);
});
