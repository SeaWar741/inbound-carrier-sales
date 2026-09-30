import { Suspense } from "react";
import { Demand } from "@/components/demand/demand";

// useSearchParams needs a Suspense boundary to prerender.
export default function DemandPage() {
  return (
    <Suspense>
      <Demand />
    </Suspense>
  );
}
