import { Suspense } from "react";
import { TowerShell } from "@/components/tower-shell";

export default function InboxPage() {
  return (
    <Suspense>
      <TowerShell />
    </Suspense>
  );
}
