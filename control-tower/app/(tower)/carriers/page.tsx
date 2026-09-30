import { Suspense } from "react";
import { Network } from "@/components/network/network";

// useSearchParams needs a Suspense boundary to prerender.
export default function CarriersPage() {
  return (
    <Suspense>
      <Network />
    </Suspense>
  );
}
