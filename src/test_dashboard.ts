import { DashboardService } from './modules/dashboard/dashboard.service';

async function test() {
  try {
    const res = await DashboardService.getSummary({
      startDate: '2026-06-24T18:30:00.000Z',
      endDate: '2026-06-25T13:03:28.954Z',
      period: 'today'
    });
    console.log("SUCCESS:", typeof res === 'object' && res !== null ? "Returned object with keys: " + Object.keys(res).join(', ') : res);
    console.log("Stats sample:", JSON.stringify(res.stats, null, 2));
  } catch (err) {
    console.error("ERROR:", err);
  }
}

test();
