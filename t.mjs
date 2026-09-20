const m = await import("ori-memory");
const names = Object.keys(m).sort();
console.log("import ori-memory  ->  OK,", names.length, "exports");
console.log(" ", names.join(", "));
console.log("  searchComposite :", typeof m.searchComposite);
console.log("  runReadOnlySql  :", typeof m.runReadOnlySql);
console.log("  VERSION         :", m.VERSION);
