// Emergency stop: cancel every open order in the tournament. Independent of the bot process,
// so it works when the bot is hung. Run with `npm run kill`.
import { Api, ApiError } from '../api.js';
import { config } from '../config.js';

async function main() {
  const api = new Api();
  const t = await api.tournament(config.tournamentSlug);
  console.log(`Cancelling all open orders in ${t.name} (${t.slug})`);

  const cancelled = await api.cancelAll({ tournamentId: t.id });
  console.log(`cancelled: ${cancelled}`);

  const left = await api.openOrders(t.id);
  console.log(`open orders remaining: ${left.length}`);
  if (left.length) {
    console.error('Some orders are still open. Run again, and stop the bot if it is re-quoting.');
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err instanceof ApiError ? err.message : err);
  process.exit(1);
});
