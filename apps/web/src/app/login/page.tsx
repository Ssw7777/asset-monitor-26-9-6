import { redirect } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";
import { LoginForm } from "@/components/LoginForm";

export default async function LoginPage() {
  if (await isAuthenticated()) redirect("/dashboard");
  return (
    <main className="login-shell min-h-screen flex items-center justify-center px-4 py-10">
      <div className="login-card w-full max-w-md p-8">
        <div className="flex items-center gap-3 mb-6">
          <span className="w-10 h-10 shrink-0 grid place-items-center rounded-full bg-slate-900 text-white font-bold">0x</span>
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Asset Monitor</h1>
            <p className="text-sm text-slate-500">自托管资产看板</p>
          </div>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
