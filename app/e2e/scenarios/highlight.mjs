// Highlighting source code and config files: which language a file is, what each
// language colors, and lines that depend on the ones above, anywhere in a file.

const SLOT = ".pane.focused .slot:not(.hidden)";

/** Line by line: the classed parts of the line as `class:text`, the rest left out. */
const SAMPLES = {
  python: [
    ["import os  # stdlib", ["keyword:import", "comment:# stdlib"]],
    ["@cached", ["fn:@cached"]],
    ["def area(x: float = 1.5e3) -> int:", ["keyword:def", "fn:area", "card:float", "number:1.5e3", "card:int"]],
    ['    return f"{x}" + \'y\'  # not "this"', ["keyword:return", 'value:"{x}"', "value:'y'", 'comment:# not "this"']],
    ["x1 = None", ["keyword:None"]],
    ['"""doc', ['value:"""doc']],
    ["still # doc", ["value:still # doc"]],
    ['end""" + 1', ['value:end"""', "number:1"]],
  ],
  shell: [
    ["#!/bin/bash", ["comment:#!/bin/bash"]],
    ['if [ -f "$file" ]; then', ["keyword:if", 'value:"$file"', "keyword:then"]],
    ["  echo $HOME ${x:-1} # done", ["card:echo", "param:$HOME", "param:${x:-1}", "comment:# done"]],
    ["fi", ["keyword:fi"]],
    ["a#b if-not", []],
    ["echo \\# no", ["card:echo"]],
    ["cat <<EOF > out", ["keyword:<<EOF"]],
    ["if $x in text", ["value:if $x in text"]],
    ["EOF", ["keyword:EOF"]],
    ["echo $((1<<2))", ["card:echo", "number:1", "number:2"]],
  ],
  batch: [
    ["@echo off", ["keyword:echo"]],
    ["REM a comment", ["comment:REM a comment"]],
    [":: another", ["comment::: another"]],
    [":label", ["fn::label"]],
    ['IF EXIST "%~dp0x" GOTO end', ["keyword:IF", "keyword:EXIST", 'value:"%~dp0x"', "keyword:GOTO"]],
    ["set A=%B% %1 !C!", ["keyword:set", "param:%B%", "param:%1", "param:!C!"]],
  ],
  powershell: [
    ["# comment", ["comment:# comment"]],
    ['$env:PATH = "a`"b"', ["param:$env:PATH", 'value:"a`"b"']],
    ["Get-ChildItem -Path $x", ["fn:Get-ChildItem", "param:$x"]],
    ["IF ($true) { Exit }", ["keyword:IF", "param:$true", "keyword:Exit"]],
    ["<# block", ["comment:<# block"]],
    ["still #>", ["comment:still #>"]],
  ],
  java: [
    ["package a.b; // why", ["keyword:package", "comment:// why"]],
    ["@Override public final String f(int n) {", ["card:@Override", "keyword:public", "keyword:final", "card:String", "fn:f", "card:int"]],
    ['  return n > 0 ? "a\\"b" : null; /* x */ ', ["keyword:return", "number:0", 'value:"a\\"b"', "keyword:null", "comment:/* x */"]],
    ["/* open", ["comment:/* open"]],
    [" * body", ["comment: * body"]],
    [" close */ int x;", ["comment: close */", "card:int"]],
  ],
  c: [
    ["#include <stdio.h>", ["keyword:#include", "value:<stdio.h>"]],
    ['#define N "x"', ["keyword:#define", 'value:"x"']],
    ["static double f(int *a) { return 0x1F; }", ["keyword:static", "card:double", "fn:f", "card:int", "keyword:return", "number:0x1F"]],
    ["char c = '\"'; // quote", ["card:char", "value:'\"'", "comment:// quote"]],
    ["int y;", ["card:int"]],
  ],
  javascript: [
    ["const a: number = 1; // c", ["keyword:const", "card:number", "number:1", "comment:// c"]],
    ["class B extends C {}", ["keyword:class", "card:B", "keyword:extends", "card:C"]],
    ["let s = `multi ${a}", ["keyword:let", "value:`multi ${a}"]],
    ["line`; run(s)", ["value:line`", "fn:run"]],
    ["$x = undefined", ["keyword:undefined"]],
  ],
  rust: [
    ["#[derive(Debug)]", ["card:#[derive(Debug)]"]],
    ["pub fn f<'a>(x: &'a str) -> Vec<u8> {", ["keyword:pub", "keyword:fn", "card:str", "card:Vec", "card:u8"]],
    ["    println!(\"{}\", '\"'); // q", ["fn:println!", 'value:"{}"', "value:'\"'", "comment:// q"]],
    ["let c = 1;", ["keyword:let", "number:1"]],
    ['let s = "two', ["keyword:let", 'value:"two']],
    ['lines"; let', ['value:lines"', "keyword:let"]],
  ],
  go: [
    ['import "fmt" // c', ["keyword:import", 'value:"fmt"', "comment:// c"]],
    ["func f(n int) error { return nil }", ["keyword:func", "fn:f", "card:int", "card:error", "keyword:return", "keyword:nil"]],
    ["s := `raw\\", ["value:`raw\\"]],
    ["text` + x", ["value:text`"]],
  ],
  fortran: [
    ["! comment", ["comment:! comment"]],
    ["SUBROUTINE UMAT(STRESS)  ! why", ["keyword:SUBROUTINE", "fn:UMAT", "comment:! why"]],
    ["  DOUBLE PRECISION X, cat", ["card:DOUBLE", "card:PRECISION"]],
    ["  IF (A .GT. 1.0D0 .AND. B) THEN", ["keyword:IF", "keyword:.GT.", "number:1.0D0", "keyword:.AND.", "keyword:THEN"]],
    ["call f('it''s')", ["keyword:call", "fn:f", "value:'it''s'"]],
    ["c = 1", ["number:1"]],
  ],
  fortranFixed: [
    ["C     a comment", ["comment:C     a comment"]],
    ["c     too", ["comment:c     too"]],
    ["* and this", ["comment:* and this"]],
    ["      SUBROUTINE UMAT(STRESS)", ["keyword:SUBROUTINE", "fn:UMAT"]],
    ["      call f ! why", ["keyword:call", "comment:! why"]],
  ],
  toml: [
    ["# comment", ["comment:# comment"]],
    ["[tool.poetry]", ["card:[tool.poetry]"]],
    ["[[bin]]", ["card:[[bin]]"]],
    ['name = "a" # why', ["param:name ", 'value:"a"', "comment:# why"]],
    ["a.b = 1_000", ["param:a.b ", "number:1_000"]],
    ["on = true", ["param:on ", "keyword:true"]],
    ["when = 1979-05-27T07:32:00Z", ["param:when ", "number:1979-05-27T07:32:00Z"]],
    ['text = """', ["param:text ", 'value:"""']],
    ["not = key", ["value:not = key"]],
    ['""" # c', ['value:"""', "comment:# c"]],
    ["list = [1, 'a']", ["param:list ", "number:1", "value:'a'"]],
  ],
  yaml: [
    ["# comment", ["comment:# comment"]],
    ["---", ["keyword:---"]],
    ["name: hello world # why", ["param:name", "punct::", "comment:# why"]],
    ["on: true", ["param:on", "punct::", "keyword:true"]],
    ["size: 1.5", ["param:size", "punct::", "number:1.5"]],
    ['title: "a: b"', ["param:title", "punct::", 'value:"a: b"']],
    ["url: http://x.y", ["param:url", "punct::"]],
    ["- item", ["punct:- "]],
    ["  - k: v", ["punct:  - ", "param:k", "punct::"]],
    ["ref: &a *b", ["param:ref", "punct::", "keyword:&a *b"]],
    ["script: |", ["param:script", "punct::", "keyword:|"]],
    ["  key: not", ["value:  key: not"]],
    ["", []],
    ["  # still", ["value:  # still"]],
    ["next: 1", ["param:next", "punct::", "number:1"]],
    ["list: [1, 'a']", ["param:list", "punct::", "number:1", "value:'a'"]],
  ],
  json: [
    ['{ "key": "value", "n": 1.5, "on": true, "no": null }', ['param:"key"', 'value:"value"', 'param:"n"', "number:1.5", 'param:"on"', "keyword:true", 'param:"no"', "keyword:null"]],
  ],
  ini: [
    ["; comment", ["comment:; comment"]],
    ["# comment", ["comment:# comment"]],
    ["[section]", ["card:[section]"]],
    ["key = value", ["param:key ", "punct:=", "value: value"]],
    ["other: more", ["param:other", "punct::", "value: more"]],
    ["nothing", []],
  ],
  xml: [
    ['<?xml version="1.0"?>', ["keyword:<?xml", "param:version", 'value:"1.0"', "punct:?>"]],
    ["<!-- a comment -->", ["comment:<!-- a comment -->"]],
    ['<a href="x" b=\'y\'>text &amp; more</a>', ["keyword:<a", "param:href", 'value:"x"', "param:b", "value:'y'", "punct:>", "param:&amp;", "keyword:</a", "punct:>"]],
    ["<!-- open", ["comment:<!-- open"]],
    ["<b> inside", ["comment:<b> inside"]],
    ["--> <c", ["comment:-->", "keyword:<c"]],
    ['  name="v"', ["param:name", 'value:"v"']],
    ["/>after", ["punct:/>"]],
  ],
  markdown: [
    ["# Heading", ["keyword:# Heading"]],
    ["> quote", ["comment:> quote"]],
    ["- item `code` and [text](url)", ["keyword:- ", "value:`code`", "param:[text]", "value:(url)"]],
    ["1. first", ["keyword:1. "]],
    ["```python", ["keyword:```python"]],
    ["# not a heading", ["value:# not a heading"]],
    ["```", ["keyword:```"]],
    ["plain", []],
  ],
};

export default async function (t) {
  const app = await t.launch();
  const { page } = app;
  await page.waitForSelector(".empty");
  const { until, check } = t;

  // ---- The scanner on its own ---------------------------------------------------

  const results = await page.evaluate(async (samples) => {
    const { scanLine } = await import("/src/lib/languages.ts");
    const out = {};
    for (const [lang, lines] of Object.entries(samples)) {
      let state = null;
      out[lang] = lines.map(([line]) => {
        const scanned = scanLine(lang, line, state);
        state = scanned.state;
        return [scanned.tokens.map((token) => token.text).join(""), scanned.tokens.filter((token) => token.cls).map((token) => `${token.cls}:${token.text}`)];
      });
    }
    return out;
  }, SAMPLES);
  for (const [lang, lines] of Object.entries(SAMPLES)) {
    lines.forEach(([line, expected], i) => {
      const [text, classed] = results[lang][i];
      check(`${lang} line ${i + 1}: ${line}`, classed, expected);
      check(`${lang} line ${i + 1} keeps its text`, text, line);
    });
  }

  // Any line whatever: the tokens give back the line, in a straight run, with a
  // state that survives being kept, and it never takes long.
  const fuzz = await page.evaluate(async (langs) => {
    const { scanLine } = await import("/src/lib/languages.ts");
    const pieces = ['"', "'", "`", '"""', "'''", "\\", "/*", "*/", "//", "#", "<#", "#>", "<!--", "-->", "<", ">", "/>", "$", "${", "%", "!", "@", "&", "*", ":", ": ", "- ", "=", "[", "]", "{", "}", "(", ")", "|", " ", "\t", "if", "def", "1", "0x", "1.5e", ".", ".eq.", "한글", "😀", "<<EOF", "EOF", "```", "~~~", "c", "a", "é"];
    let seed = 12345;
    const random = (n) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    const failures = [];
    let lines = 0;
    const started = performance.now();
    for (const lang of langs) {
      let state = null;
      for (let n = 0; n < 4000; n++) {
        let line = "";
        for (let count = random(12); count > 0; count--) line += pieces[random(pieces.length)];
        const { tokens, state: next } = scanLine(lang, line, state);
        lines++;
        if (tokens.map((token) => token.text).join("") !== line) failures.push([lang, line]);
        if (JSON.stringify(JSON.parse(JSON.stringify(next))) !== JSON.stringify(next)) failures.push([lang, "state", line]);
        state = next;
      }
    }
    // A very long line, the longest the core shows, of what could be slow.
    const long = {};
    for (const lang of langs) {
      for (const piece of ['"', "\\", "a ", "/*", "<a ", "[", "- ", "$", "# "]) {
        const line = piece.repeat(16384 / piece.length);
        const at = performance.now();
        const { tokens } = scanLine(lang, line, null);
        if (tokens.map((token) => token.text).join("") !== line) failures.push([lang, "long", piece]);
        long[`${lang} ${piece}`] = performance.now() - at;
      }
    }
    const slowest = Object.entries(long).sort((a, b) => b[1] - a[1]);
    return { failures: failures.slice(0, 5), lines, ms: performance.now() - started, slowest: slowest[0], next: slowest.slice(1, 4) };
  }, Object.keys(SAMPLES));
  check("any line comes back whole", fuzz.failures, []);
  console.log(`       scanned ${fuzz.lines} lines in ${Math.round(fuzz.ms)} ms; slowest long lines: ${JSON.stringify([fuzz.slowest, ...fuzz.next].map(([what, ms]) => [what, Math.round(ms)]))}`);
  check(`no long line is slow to scan (slowest: ${fuzz.slowest[0]}, ${Math.round(fuzz.slowest[1])} ms)`, fuzz.slowest[1] < 50, true);

  // ---- Which language a file is ---------------------------------------------------

  const FILES = {
    "a.py": ["Python", "Py"], "a.pyw": ["Python", "Py"], "a.sh": ["Shell", "Sh"], "a.bash": ["Shell", "Sh"], "a.zsh": ["Shell", "Sh"],
    "a.bat": ["Batch", "Bt"], "a.cmd": ["Batch", "Bt"], "a.ps1": ["PowerShell", "PS"], "A.JAVA": ["Java", "Ja"],
    "a.c": ["C/C++", "C"], "a.h": ["C/C++", "C"], "a.cpp": ["C/C++", "C"], "a.hpp": ["C/C++", "C"],
    "a.js": ["JavaScript", "JS"], "a.mjs": ["JavaScript", "JS"], "a.ts": ["JavaScript", "JS"], "a.tsx": ["JavaScript", "JS"],
    "a.rs": ["Rust", "Rs"], "a.go": ["Go", "Go"], "a.f90": ["Fortran", "F"], "a.for": ["Fortran", "F"], "umat.f": ["Fortran", "F"],
    "a.toml": ["TOML", "TM"], "a.yaml": ["YAML", "YM"], "a.yml": ["YAML", "YM"], "a.json": ["JSON", "{}"],
    "a.ini": ["INI", "In"], "a.cfg": ["INI", "In"], "a.xml": ["XML/HTML", "<>"], "a.html": ["XML/HTML", "<>"], "a.md": ["Markdown", "MD"],
  };
  const files = Object.fromEntries(Object.keys(FILES).map((name) => [`files/${name}`, "x\n"]));
  t.write({ ...files, "files/a.inp": "*Node\n", "files/a.bdf": "GRID\n", "files/a.txt": "x\n", "files/noext": "x\n" });
  const seen = {};
  for (const name of [...Object.keys(FILES), "a.inp", "a.bdf", "a.txt", "noext"]) {
    await app.open(t.path("files", name));
    seen[name] = [await app.language(), (await page.locator(".strip .tab.active .badge").count()) ? await page.textContent(".strip .tab.active .badge") : null];
    await page.keyboard.press("Control+w");
    await until(`closed ${name}`, () => page.locator(".strip .tab").count(), 0);
  }
  check("the languages of files", seen, { ...FILES, "a.inp": ["Abaqus", "A"], "a.bdf": ["Nastran", "N"], "a.txt": ["Plain text", null], "noext": ["Plain text", null] });
  await until("the explorer marks them too", async () => (await page.$$eval(".row", (rows) => rows.filter((row) => row.querySelector(".name")?.textContent === "a.py").map((row) => row.querySelector(".badge")?.textContent)))[0], "Py");

  // ---- On screen ------------------------------------------------------------------

  const classed = (cls) => page.$$eval(`${SLOT} .lines .${cls}`, (els) => els.map((e) => e.textContent));
  t.write({ "show.py": 'import os  # stdlib\n\ndef area(x):\n    return "a" + 1.5\n' });
  await app.open(t.path("show.py"));
  await until("colored on screen", async () => [await classed("keyword"), await classed("comment"), await classed("fn"), await classed("value"), await classed("number")], [["import", "def", "return"], ["# stdlib"], ["area"], ['"a"'], ["1.5"]]);
  check("the text is the file's", await app.lines(), ["import os  # stdlib", "", "def area(x):", '    return "a" + 1.5', ""]);
  const colors = await page.$$eval(`${SLOT} .lines span`, (els) => [...new Set(els.map((e) => getComputedStyle(e).fontWeight))]);
  check("color only, no bold", colors, ["400"]);
  await app.shot("highlight-python");

  // Selection, caret and box work over the pieces.
  await page.mouse.click(...(await app.at(3, 11)));
  await until("a click among them", app.position, "Ln 4, Col 12");
  await page.keyboard.press("Shift+End");
  await until("a selection across them", app.position, "Ln 4, Col 21 (9 selected)");
  await page.keyboard.press("Control+c");
  await until("copied", app.clipboard, '"a" + 1.5');
  await page.keyboard.press("Home");
  await page.keyboard.type("Z");
  await until("typing recolors", async () => (await app.lines())[3].startsWith("    Zreturn") || (await app.lines())[3].startsWith("Z"), true);
  await page.keyboard.press("Control+z");

  // Off in the menu, off here.
  await app.menu("View", "Syntax Highlighting");
  await until("off", () => classed("keyword"), []);
  await app.menu("View", "Syntax Highlighting");
  await until("on", async () => (await classed("keyword")).length, 3);

  // A hidden tab is a file like another.
  await page.keyboard.press("Control+w");

  // ---- Lines that depend on the ones above ----------------------------------------

  const code = Array.from({ length: 300 }, (_, i) => `x${i} = ${i}`);
  const doc = Array.from({ length: 300 }, (_, i) => `doc line ${i}`);
  const PY = ["# top", 'r"""', ...doc, '"""', ...code, ""].join("\n");
  t.write({ "long.py": PY });
  const plainNumbers = async () => (await classed("number")).length;
  const goTo = async (line) => {
    await page.keyboard.press("Control+g");
    await page.waitForSelector(".goto input");
    await page.keyboard.type(String(line));
    await page.keyboard.press("Enter");
    await until(`at line ${line}`, app.position, `Ln ${line}, Col 1`);
  };
  const allString = async () => {
    const lines = await app.lines();
    const strings = (await classed("value")).join("");
    return lines.every((line) => strings.includes(line));
  };

  // Straight into the middle of a long string, from a fresh start.
  await app.open(t.path("long.py"));
  await goTo(150);
  await until("jumped into a string: it is a string", async () => [await allString(), await plainNumbers()], [true, 0]);
  await app.shot("highlight-inside");
  await goTo(450);
  await until("jumped past it: code", async () => [(await classed("value")).length, (await plainNumbers()) > 10], [0, true]);

  // Scrolling across its end, in both directions, line by line.
  await goTo(240);
  await until("back inside", async () => [await allString(), await plainNumbers()], [true, 0]);
  for (let n = 0; n < 45; n++) await page.keyboard.press("Control+ArrowDown");
  await until("the end of it in view", async () => (await app.lines()).includes('"""'), true);
  const acrossEnd = async () => {
    const lines = await app.lines();
    const at = lines.indexOf('"""');
    const strings = (await classed("value")).join("\n");
    const numbers = await classed("number");
    return [lines.slice(0, at).every((line) => strings.includes(line)), numbers.length === lines.length - at - 1];
  };
  await until("string above it, code below", acrossEnd, [true, true]);
  for (let n = 0; n < 20; n++) await page.keyboard.press("Control+ArrowUp");
  await until("scrolled back up: all as it should be", async () => {
    const lines = await app.lines();
    return lines.includes('"""') ? (await acrossEnd())[0] : await allString();
  }, true);

  // An edit far above, in this very pane.
  await page.keyboard.press("Control+Home");
  await page.keyboard.type('"""');
  await goTo(450);
  await until("a quote at the top: what was code is a string", async () => [await allString(), await plainNumbers()], [true, 0]);
  await goTo(150);
  await until("and what was a string is code", async () => (await classed("value")).length, 0);
  await page.keyboard.press("Control+z");
  await goTo(150);
  await until("undone: a string again", async () => [await allString(), await plainNumbers()], [true, 0]);
  await goTo(450);
  await until("code again", async () => [(await classed("value")).length, (await plainNumbers()) > 10], [0, true]);

  // An edit above changes what is below it, wherever the view is.
  await page.keyboard.press("Control+\\");
  await until("two panes", () => page.locator(".pane").count(), 2);
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+1");
  await goTo(150);
  await until("string in this pane", async () => [await allString(), await plainNumbers()], [true, 0]);
  await page.keyboard.press("Control+2");
  await page.keyboard.type('"""');
  await page.keyboard.press("Control+1");
  await until("a quote typed far above, in the other pane: this is code now", async () => {
    const numbers = await page.$$eval(`.pane[data-pane="0"] .slot:not(.hidden) .lines .number`, (els) => els.length);
    const strings = await page.$$eval(`.pane[data-pane="0"] .slot:not(.hidden) .lines .value`, (els) => els.length);
    return [strings, numbers > 5];
  }, [0, true]);
  await goTo(450);
  await until("and what was code is a string", async () => [await allString(), await plainNumbers()], [true, 0]);
  await page.keyboard.press("Control+2");
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+1");
  await until("undone: code again", async () => [(await classed("value")).length, (await plainNumbers()) > 10], [0, true]);
  await page.keyboard.press("Control+\\");
  await until("one pane", () => page.locator(".pane").count(), 1);

  // Lines read before an edit but arriving after it say nothing about the text now.
  await page.keyboard.press("Control+\\");
  await until("two panes", () => page.locator(".pane").count(), 2);
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+1");
  await goTo(150);
  await until("a string in the first pane", async () => [await allString(), await plainNumbers()], [true, 0]);
  await page.evaluate(() => {
    const internals = window.__TAURI_INTERNALS__;
    const invoke = internals.invoke;
    window.__slowViews = 300;
    // The answer is on its way, read as things were: the wait comes after the reading.
    internals.invoke = async (cmd, ...rest) => {
      const delay = cmd === "view" ? window.__slowViews : 0;
      const answer = await invoke(cmd, ...rest);
      if (delay) await new Promise((done) => setTimeout(done, delay));
      return answer;
    };
  });
  // Far enough for the state there not to be known, so that it is being read as well.
  for (let n = 0; n < 40; n++) await page.keyboard.press("Control+ArrowDown");
  await page.keyboard.press("Control+2");
  await page.keyboard.type('"""');
  await page.evaluate(() => (window.__slowViews = 0));
  await page.keyboard.press("Control+1");
  await until("what was read before the edit does not stick", async () => {
    const numbers = await page.$$eval(`.pane[data-pane="0"] .slot:not(.hidden) .lines .number`, (els) => els.length);
    const strings = await page.$$eval(`.pane[data-pane="0"] .slot:not(.hidden) .lines .value`, (els) => els.length);
    return [strings, numbers > 5];
  }, [0, true]);
  await page.keyboard.press("Control+2");
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+\\");
  await until("one pane", () => page.locator(".pane").count(), 1);

  // And when such lines start above the edit, their states must not be remembered:
  // here the quote that opens the string goes, while the old lines are on their way.
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await until("the opening selected", app.position, 'Ln 2, Col 5 (4 selected)');
  await page.evaluate(() => (window.__slowViews = 300));
  await page.keyboard.press("Control+ArrowDown");
  await page.keyboard.press("Delete");
  await page.evaluate(() => (window.__slowViews = 0));
  await until("gone", async () => (await app.status()).includes("Modified"), true);
  await page.waitForTimeout(700);
  // A jump: going line by line would write over whatever was remembered wrongly.
  await goTo(60);
  await until("the lines below are code now", async () => (await classed("value")).length, 0);
  await page.keyboard.press("Control+z");
  await until("undone", async () => (await app.status()).includes("Modified"), false);

  // A view near the end of a file starts earlier than asked, to fill its rows;
  // the lines before the place reached must not be read twice.
  const tail = ["# top", ...Array.from({ length: 249 }, (_, i) => `a${i} = ${i}`), 'r"""', ...doc.slice(0, 19), '"""', ...code.slice(0, 29), ""].join("\n");
  t.write({ "tail.py": tail });
  await page.setViewportSize({ width: 1280, height: 320 });
  await app.open(t.path("tail.py"));
  await goTo(255);
  await until("in the string, a short window", async () => [await allString(), await plainNumbers()], [true, 0]);
  await page.keyboard.press("Control+End");
  await until("the code after it, at the end", async () => [(await classed("value")).length, (await plainNumbers()) > 3], [0, true]);
  await page.setViewportSize({ width: 1280, height: 800 });

  // Typing the end of a block right here recolors what follows at once.
  t.write({ "typed.java": "class A {\n/* open\nint a = 1;\nint b = 2;\n}\n" });
  await app.open(t.path("typed.java"));
  await until("comment to the end", () => classed("number"), []);
  await page.mouse.click(...(await app.at(1, 7)));
  await page.keyboard.type(" */");
  await until("closed: code after it", () => classed("number"), ["1", "2"]);
  await page.keyboard.press("Control+z");
  await until("open again", () => classed("number"), []);

  // The file's last lines: a view there starts earlier than asked.
  t.write({ "end.py": ['r"""', ...doc.slice(0, 20), '"""', "z = 1", ""].join("\n") });
  await app.open(t.path("end.py"));
  await page.keyboard.press("Control+End");
  await until("near the end, the state is right", () => classed("number"), ["1"]);
  await page.keyboard.press("Control+Home");
  await until("and at the top", async () => (await classed("value")).length > 5, true);

  // Reading it in another encoding starts over.
  await app.open(t.path("long.py"));
  await goTo(150);
  await until("still a string", allString, true);
  await page.click(".statusbar .status-button");
  await page.click(".menu .modes button:has-text('Read as')");
  await page.click(".menu button.item:has-text('Windows-1252')");
  await until("read again", app.encoding, "Windows-1252");
  await page.waitForFunction(() => document.querySelector(".statusbar")?.textContent);
  await until("still right", async () => (await app.position()).startsWith("Ln"), true);

  // Far into a big file, nothing is read to find out: it stays quick.
  const lots = 'x = 1  # a line of a big file, not at all interesting to read\n'.repeat(400000);
  t.write({ "big.py": 'r"""\n' + lots });
  await app.open(t.path("big.py"));
  await until("all a string near the top", async () => (await classed("number")).length, 0);
  const started = Date.now();
  await page.keyboard.press("Control+End");
  await until("past the limit, the screen starts afresh", async () => (await classed("number")).length > 5, true);
  check(`and quickly (${Date.now() - started} ms)`, Date.now() - started < 3000, true);
  await page.keyboard.type("y");
  await until("typing there works", async () => (await app.lines()).at(-1), "y");
  await page.keyboard.press("Control+z");
}
