const destroyTestDb = async () => {
  const file = Bun.file("test.sqlite");
  if (await file.exists()) {
    await file.delete();
  }
  console.log("Test database destroyed");
};

destroyTestDb();
