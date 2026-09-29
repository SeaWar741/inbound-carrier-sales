import { Suspense } from "react";
import { TowerShell } from "@/components/tower-shell";

export default function TowerPage() {
  return (
    <Suspense>
      <TowerShell />
    </Suspense>
  );
}
