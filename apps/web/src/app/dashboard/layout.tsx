import { redirect } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";
import { DashboardShell } from "@/components/DashboardShell";

/**
 * 鉴权：middleware（Edge）+ 本 layout（服务端）双门禁，不削弱登录安全。
 * DashboardShell 常驻 layout，顶栏软切换不卸挂整棵看板，避免重复拉全量 portfolio。
 * children 仅占位保留路由；旧 changes/flows 由 Shell 映射 section，子页不再 redirect。
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  if (!(await isAuthenticated())) redirect("/login");
  return (
    <>
      <DashboardShell />
      <div hidden aria-hidden>
        {children}
      </div>
    </>
  );
}
