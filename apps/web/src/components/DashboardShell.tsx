"use client";

import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { usePathname } from "next/navigation";
import { Dashboard, type DashboardSection } from "./Dashboard";
import styles from "./workspace.module.css";

const BASE = process.env.NEXT_PUBLIC_STUDY_BASE_PATH || "";
const SECTIONS: { id: DashboardSection; label: string; short: string }[] = [
  { id: "overview", label: "总览", short: "Overview" },
  { id: "tokens", label: "代币", short: "Tokens" },
  { id: "defi", label: "DeFi", short: "DeFi" },
  { id: "exchanges", label: "交易所", short: "Exchanges" },
  { id: "manual", label: "手动", short: "Manual" },
  { id: "addresses", label: "地址", short: "Addresses" },
];

function sectionFromPath(pathname: string): DashboardSection {
  const part = pathname.split("/").filter(Boolean).at(-1);
  return SECTIONS.find((item) => item.id === part)?.id ?? "overview";
}

export function DashboardShell() {
  const pathname = usePathname() || "/dashboard";
  const [active, setActive] = useState<DashboardSection>(() => sectionFromPath(pathname));
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => { setActive(sectionFromPath(pathname)); }, [pathname]);
  useEffect(() => {
    const onPop = () => setActive(sectionFromPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    if (!mobileOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setMobileOpen(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [mobileOpen]);

  const current = useMemo(() => SECTIONS.find((item) => item.id === active) ?? SECTIONS[0], [active]);

  function go(event: MouseEvent<HTMLAnchorElement>, id: DashboardSection) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    event.preventDefault();
    setActive(id);
    setMobileOpen(false);
    window.history.pushState(null, "", BASE + "/dashboard/" + id);
  }

  return (
    <div className={styles.workspace} data-mobile-open={mobileOpen}>
      {mobileOpen && <button className={styles.scrim} type="button" aria-label="关闭侧栏" onClick={() => setMobileOpen(false)} />}
      <aside className={styles.sidebar} id="study-sidebar" aria-label="资产看板导航">
        <div className={styles.sideHead}>
          <a className={styles.wordmark} href={BASE + "/dashboard/overview"} onClick={(event) => go(event, "overview")}>
            <span className={styles.logo}>0x</span><span>Asset Monitor<small>自托管资产看板</small></span>
          </a>
          <button className={styles.iconButton + " " + styles.mobileToggle} aria-label="关闭侧栏" onClick={() => setMobileOpen(false)}>×</button>
        </div>

        <nav className={styles.nav} aria-label="板块">
          <div className={styles.assetRow}>
            <a className={styles.navItem} href={BASE + "/dashboard/" + active} onClick={(event) => go(event, active)} aria-current="location">
              <span className={styles.moduleIcon}>¥</span><span className={styles.itemText}>我的资产</span>
            </a>
          </div>
          <div className={styles.subnav}>
            {SECTIONS.map((item) => (
              <a key={item.id} href={BASE + "/dashboard/" + item.id} className={styles.subItem} aria-current={active === item.id ? "page" : undefined} onClick={(event) => go(event, item.id)}>
                <span className={styles.sectionDot} />{item.label}
              </a>
            ))}
          </div>
        </nav>

        <div className={styles.sideFoot}>
          <div className={styles.profile}><span className={styles.profileMark}>0x</span><span>Local workspace<small>Self-hosted</small></span></div>
          <button className={styles.iconButton} aria-label="退出登录" title="退出登录" onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.assign(BASE + "/login"); }}>↪</button>
        </div>
      </aside>

      <section className={styles.main} aria-label="当前看板">
        <header className={styles.top}>
          <div className={styles.crumb}>
            <button className={styles.iconButton + " " + styles.mobileToggle} aria-label="打开侧栏" aria-expanded={mobileOpen} onClick={() => setMobileOpen(true)}>☰</button>
            <span>我的资产</span><b>/</b><strong>{current.label}</strong>
          </div>
          <span className={styles.topNote}>{current.short}</span>
        </header>
        <div className={styles.content}>
          <Dashboard section={active} />
        </div>
      </section>
    </div>
  );
}
