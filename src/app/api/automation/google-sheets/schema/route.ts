import { automationOk, guardAutomationRequest } from "@/lib/automation/guard";
import { buildSheetSchemaDocument } from "@/lib/google-sheets/sheet-schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/automation/google-sheets/schema
 *
 * The spreadsheet layout, machine-readable: tab names, the required column
 * headers in order, the unique matching column per tab, and a data type for
 * each column.
 *
 * ## What it is for
 *
 * Three jobs, all of which are currently done by a person reading documentation
 * and typing carefully:
 *
 * 1. **Building the sheet.** A one-off workflow can create the seven tabs and
 *    write their header rows from this document, rather than an operator pasting
 *    column names and getting one subtly wrong.
 * 2. **Configuring a branch.** `match_column` is what n8n's "Column to Match On"
 *    needs. Get it wrong and every Append-or-Update silently becomes an Append,
 *    which is not visible until the sheet has a week of duplicates in it.
 * 3. **Drift detection.** A workflow can compare the live header row against
 *    `required_columns` and refuse to write into a sheet somebody has reordered.
 *
 * ## Why it is a read, and why it is still authenticated
 *
 * It touches no database and contains no data — only structure. But it is
 * behind the same bearer secret as everything else on this surface: the column
 * layout tells an attacker exactly what this system collects and how it is
 * keyed, which is reconnaissance worth withholding for free.
 *
 * It describes structure only. There is no Google credential anywhere in this
 * application to describe — n8n owns that — and no tab carries a Page token.
 */
export async function GET(request: Request) {
  const guard = guardAutomationRequest(request, "read");
  if (!guard.ok) return guard.response;

  return automationOk(buildSheetSchemaDocument(), 200, guard.headers);
}
