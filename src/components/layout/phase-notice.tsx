import { Construction } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

type PhaseNoticeProps = {
  /** The phase in which this screen gets its real behaviour. */
  phase: number;
  /** What will exist here once that phase ships. */
  children: React.ReactNode;
};

/**
 * Every placeholder screen carries one of these. It is the visible contract
 * that nothing on the page is real data — no mocked charts, no seeded numbers,
 * no fake production functionality.
 */
export function PhaseNotice({ phase, children }: PhaseNoticeProps) {
  return (
    <Alert>
      <Construction />
      <AlertTitle>Placeholder — arrives in Phase {phase}</AlertTitle>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
