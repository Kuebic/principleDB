import { describe, expect, it } from 'vitest';

import { htmlToText } from './html-to-text';

describe('htmlToText', () => {
  it('extracts plain body text from a minimal document', () => {
    const { text } = htmlToText('<html><body><p>Hello world.</p></body></html>');
    expect(text).toBe('Hello world.');
  });

  it('strips <script> and <style> blocks entirely', () => {
    const html = `
      <html>
        <head><style>body{color:red}</style></head>
        <body>
          <script>alert('bad')</script>
          <p>Visible.</p>
          <script>var x = 1;</script>
        </body>
      </html>
    `;
    const { text } = htmlToText(html);
    expect(text).toBe('Visible.');
    expect(text).not.toMatch(/alert/);
    expect(text).not.toMatch(/color:red/);
  });

  it('strips <head>, <nav>, <noscript>, <meta>, <link>, and HTML comments', () => {
    const html = `
      <html>
        <head>
          <title>doc title</title>
          <meta name="x" content="y">
          <link rel="stylesheet" href="x.css">
        </head>
        <body>
          <nav>nav menu</nav>
          <noscript>noscript text</noscript>
          <!-- a comment -->
          <p>Body content.</p>
        </body>
      </html>
    `;
    const { text } = htmlToText(html);
    expect(text).toBe('Body content.');
    expect(text).not.toMatch(/nav menu/);
    expect(text).not.toMatch(/noscript text/);
    expect(text).not.toMatch(/doc title/);
    expect(text).not.toMatch(/a comment/);
  });

  it('decodes HTML entities (named and numeric)', () => {
    const { text } = htmlToText(
      '<p>5 &lt; 10 &amp; rock&#39;n roll &#x2014; ok &nbsp;done</p>',
    );
    expect(text).toContain('5 < 10');
    expect(text).toContain('&');
    expect(text).toContain("rock'n roll");
    expect(text).toContain('—');
  });

  it('preserves paragraph breaks between block elements', () => {
    const html = '<body><p>First.</p><p>Second.</p></body>';
    const { text } = htmlToText(html);
    expect(text).toBe('First.\n\nSecond.');
  });

  it('treats <br>, <li>, <tr>, <div> as line-breaking', () => {
    const cases: Array<[string, string]> = [
      ['<p>a<br>b</p>', 'a\nb'],
      ['<ul><li>one</li><li>two</li></ul>', 'one\ntwo'],
      ['<table><tr><td>r1</td></tr><tr><td>r2</td></tr></table>', 'r1\nr2'],
      ['<div>x</div><div>y</div>', 'x\ny'],
    ];
    for (const [html, expected] of cases) {
      expect(htmlToText(html).text).toBe(expected);
    }
  });

  it('collapses runs of whitespace within a line to a single space', () => {
    const html = '<p>   too    much\t\twhitespace   here   </p>';
    const { text } = htmlToText(html);
    expect(text).toBe('too much whitespace here');
  });

  it('collapses three or more consecutive blank lines down to a paragraph break', () => {
    const html = '<p>a</p><p></p><p></p><p></p><p>b</p>';
    const { text } = htmlToText(html);
    expect(text).toBe('a\n\nb');
  });

  it('returns empty text when the body has no content', () => {
    expect(htmlToText('<html><body></body></html>').text).toBe('');
    expect(htmlToText('').text).toBe('');
  });

  it('handles tag-soup HTML gracefully (no thrown errors)', () => {
    const html = '<p>open paragraph without close <b>bold<i>nested</p><div>more';
    expect(() => htmlToText(html)).not.toThrow();
    const { text } = htmlToText(html);
    expect(text).toContain('open paragraph without close');
    expect(text).toContain('bold');
    expect(text).toContain('more');
  });

  it('returns a headings array (may be empty in this slice)', () => {
    const { headings } = htmlToText('<body><p>nothing</p></body>');
    expect(Array.isArray(headings)).toBe(true);
  });
});
