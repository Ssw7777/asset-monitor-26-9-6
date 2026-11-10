import { redirect } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";

export default async function Home() {
  const ok = await isAuthenticated();
  redirect(ok ? "/dashboard" : "/login");
}
