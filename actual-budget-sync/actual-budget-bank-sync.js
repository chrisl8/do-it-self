import { init, downloadBudget, runBankSync, shutdown } from '@actual-app/api';

(async () => {
  await init({
    // Budget data will be cached locally here, in subdirectories for each file.
    dataDir: `${process.env.HOME}/actual-budget-data-from-metatron`,
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

  await runBankSync();
  //   let budget = await getBudgetMonth('2025-12');
  //   console.log(budget);
  await shutdown();
})();
