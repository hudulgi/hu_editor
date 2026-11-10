// The file types of the open and save dialogs: all files to open, and to save,
// the type of the file first, with its extension first.

export default async function (t) {
  t.write({ "model.inp": "*Heading\n", "DECK.DAT": "SOL 101\n", "run.py": "", "job.f06": "", "notes.xyz": "", Makefile: "", ".bashrc": "" });
  const app = await t.launch({ launchPath: t.path("model.inp") });
  const { page } = app;
  const { until, check } = t;
  await page.waitForSelector(".line");
  const offered = async () => (await app.dialogTypes()).at(-1);
  const savingAs = async (name) => {
    // Opening what is open already would not wait, and the address bar would still be busy with it.
    if ((await app.path()) !== t.path(name)) await app.open(t.path(name));
    const before = (await app.dialogCalls()).length;
    await app.answerDialog(null);
    await page.keyboard.press("Control+Shift+s");
    await until(`save as ${name}`, async () => (await app.dialogCalls()).length, before + 1);
    return offered();
  };

  await app.answerDialog(null);
  await app.menu("File", "Open…");
  await until("open", async () => (await app.dialogCalls()).length, 1);
  const all = await offered();
  check("to open: all files first, then the solvers', then text", all.slice(0, 6), [
    "All files: *",
    "Solver input: inp bdf dat nas bulk fem blk",
    "Abaqus: inp blk",
    "Nastran: bdf dat nas bulk fem blk",
    "Solver output: f06 f04 pch msg sta",
    "Text files: txt log",
  ]);
  check("then each language highlighted, by name", all.slice(6).map((type) => type.split(":")[0]), [
    "Batch",
    "C/C++",
    "CSV",
    "Fortran",
    "Go",
    "INI",
    "Java",
    "JavaScript",
    "JSON",
    "Markdown",
    "PowerShell",
    "Python",
    "Rust",
    "Shell",
    "TOML",
    "TSV",
    "XML/HTML",
    "YAML",
  ]);
  check("both Fortrans in one", all.find((type) => type.startsWith("Fortran")), "Fortran: f90 f95 f03 f08 f for ftn f77 fpp");

  const saved = await savingAs("model.inp");
  check("to save: the narrowest type of the file first, then all files", saved.slice(0, 2), ["Abaqus: inp blk", "All files: *"]);
  check("and every other", saved.length, all.length);
  check("its extension first, whatever its case", (await savingAs("DECK.DAT"))[0], "Nastran: dat bdf nas bulk fem blk");
  check("a language", (await savingAs("run.py"))[0], "Python: py pyw pyi");
  check("solver output", (await savingAs("job.f06"))[0], "Solver output: f06 f04 pch msg sta");
  check("a dot file", (await savingAs(".bashrc"))[0], "Shell: bashrc sh bash zsh ksh zshrc profile");
  check("an extension of no type: no types, so nothing added to the name", await savingAs("notes.xyz"), []);
  check("no extension: the same", await savingAs("Makefile"), []);

  // A new document is first saved as Abaqus, as it is named.
  await page.keyboard.press("Control+n");
  await until("new", async () => (await app.tabs()).at(-1), "*Untitled-1");
  await app.answerDialog(null);
  await page.keyboard.press("Control+s");
  await until("asked", async () => (await app.dialogCalls()).at(-1), "Untitled-1.inp");
  check("as Abaqus", (await offered())[0], "Abaqus: inp blk");
  // New File… with a name: the dialog for where to make it.
  await app.menu("File", "New File…");
  await page.waitForSelector(".picker");
  await page.keyboard.type("tool.py");
  await app.answerDialog(null);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await until("where to make it", async () => (await app.dialogCalls()).at(-1), "tool.py");
  check("as what it is named", (await offered())[0], "Python: py pyw pyi");

  // In Korean.
  const korean = await t.launch({ settings: { language: "ko" } });
  await korean.page.waitForSelector(".empty");
  await korean.answerDialog(null);
  await korean.page.keyboard.press("Control+o");
  await until("open in Korean", async () => (await korean.dialogCalls()).length, 1);
  check(
    "the names in Korean",
    (await korean.dialogTypes())[0].slice(0, 6).map((type) => type.split(":")[0]),
    ["모든 파일", "해석 입력 파일", "Abaqus", "Nastran", "해석 결과 파일", "텍스트 파일"],
  );
}
