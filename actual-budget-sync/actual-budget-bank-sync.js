import { init, downloadBudget, runBankSync, shutdown } from "@actual-app/api";

// Exit code for "synced, but an account needs attention"; see sync-actual-budget.sh
const EXIT_WARNING = 2;

(async () => {
  const actual = await init({
    // Budget data will be cached locally here, in subdirectories for each file.
    dataDir: `${process.env.HOME}/actual-budget-sync-data`,
    // This is the URL of your running server
    serverURL: `https://actual.${process.env.TS_DOMAIN}`,
    // This is the password you use to log into the server
    password: process.env.ACTUAL_SERVER_PASSWORD,
  });

  // This is the ID from Settings → Show advanced settings → Sync ID
  await downloadBudget(process.env.SYNC_ID);
  // or, if you have end-to-end encryption enabled:
  //   await api.downloadBudget('1cfdbb80-6274-49bf-b0c2-737235a4c81f', {
  //     password: 'password1',
  //   });

  // runBankSync() syncs every account, then throws only the FIRST error. An
  // account the bank wants attention on (e.g. SimpleFIN upgrading a connection)
  // is a warning, not a failure: the other accounts already synced. But that
  // first error could be masking a real one (a disconnected account), so check
  // every account's persisted status and only downgrade if nothing else is wrong.
  let exitCode = 0;
  try {
    await runBankSync();
  } catch (err) {
    if (err.code !== "ACCOUNT_NEEDS_ATTENTION") throw err;
    const accounts = (await actual.send("accounts-get")).filter(
      (a) => !a.closed,
    );
    const broken = accounts.filter(
      (a) =>
        a.bank_sync_status &&
        !["ok", "attention-required"].includes(a.bank_sync_status),
    );
    if (broken.length > 0) {
      throw new Error(
        `Accounts failing sync: ${broken.map((a) => `"${a.name}" (${a.bank_sync_status})`).join(", ")}`,
      );
    }
    console.error(`WARNING: ${err.message} (${err.code})`);
    exitCode = EXIT_WARNING;
  }
  //   let budget = await getBudgetMonth('2025-12');
  //   console.log(budget);
  await shutdown();
  process.exitCode = exitCode;
})();
