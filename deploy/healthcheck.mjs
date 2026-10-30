// HTTP liveness only. Save and sync setup requires the separate check:sync inventory.
try {
  const response = await fetch("http://127.0.0.1:3000/login", {
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  process.exitCode = response.status === 200 ? 0 : 1;
  await response.body?.cancel();
} catch {
  process.exitCode = 1;
}
