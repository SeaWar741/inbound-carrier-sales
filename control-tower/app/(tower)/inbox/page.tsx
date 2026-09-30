import { Suspense } from "react";
import { Inbox } from "@/components/inbox/inbox";

// useSearchParams needs a Suspense boundary to prerender.
export default function InboxPage() {
  return (
    <Suspense>
      <Inbox />
    </Suspense>
  );
}
