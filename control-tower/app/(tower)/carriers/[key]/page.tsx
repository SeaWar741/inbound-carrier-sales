import { CarrierPage } from "@/components/network/carrier-page";

// Next hands the key over decoded ("mc:123"); the page encodes it again for each API call.
export default async function CarrierKeyPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  // The segment arrives still percent-encoded (mc%3A9000029); a malformed one is passed as is.
  let carrierKey = key;
  try {
    carrierKey = decodeURIComponent(key);
  } catch {}
  return <CarrierPage carrierKey={carrierKey} />;
}
