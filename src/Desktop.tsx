import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowRight,
  BookOpen,
  ClockCounterClockwise,
  GearSix,
  House,
  Microphone,
  SidebarSimple,
  CaretRight,
  UserFocus,
  ShieldCheck,
} from "@phosphor-icons/react";
import { Brand, go } from "./components";
import { interviewRecordPath, readInterviewRecords } from "./interviewRecords";
import type { Session } from "./types";
import { version } from "../package.json";
import "./agent-shell.css";

const sidebarPreferenceKey = "kaikou.ui.sidebarCollapsed.v1";
function readSidebarPreference() {
  try { return localStorage.getItem(sidebarPreferenceKey) === "1"; }
  catch { return false; }
}

type RecentEntry = { id: string; title: string; path: string; time: string; kind: "expression" | "interview"; pending?: boolean };
function readSidebarRecords() {
  return { ...readInterviewRecords(), pending: readPendingInterview() };
}

export function useDesktop() {
  const [desktop, setDesktop] = useState(
    () => window.matchMedia("(min-width: 1000px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1000px)");
    const change = () => setDesktop(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return desktop;
}
export function navigationGroup(path: string) {
  if (
    path === "/thinking" ||
    path === "/structures" ||
    path === "/plan" ||
    path.startsWith("/lesson/")
  )
    return "/thinking";
  if (path.startsWith("/practice/") || path === "/logic" || path === "/library")
    return "/practice/improv";
  if (path.startsWith("/record/")) return "/history";
  return path;
}
export const mainNavigation = [
  { path: "/", label: "首页", icon: House },
  { path: "/practice/improv", label: "表达训练", icon: Microphone },
  { path: "/interview", label: "模拟面试", icon: UserFocus },
  { path: "/thinking", label: "方法学习", icon: BookOpen },
  { path: "/history", label: "练习记录", icon: ClockCounterClockwise },
];
export function DesktopShell({
  path,
  children,
  sessions,
  desktop = true,
}: {
  path: string;
  desktop?: boolean;
  sessions: Session[];
  children: ReactNode;
}) {
  const selected = navigationGroup(path);
  const [collapsed, setCollapsed] = useState(readSidebarPreference);
  const [preferenceNotice, setPreferenceNotice] = useState("");
  const [sidebarRecords, setSidebarRecords] = useState(readSidebarRecords);
  const [tooltip, setTooltip] = useState<{ label: string; top: number; left: number } | null>(null);
  useEffect(() => {
    const refresh = () => setSidebarRecords(readSidebarRecords());
    const storage = (event: StorageEvent) => {
      if (event.key === sidebarPreferenceKey || event.key === null) setCollapsed(readSidebarPreference());
      refresh();
    };
    refresh();
    window.addEventListener("hashchange", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", storage);
    window.addEventListener("kaikou-interview-records-changed", refresh);
    return () => {
      window.removeEventListener("hashchange", refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", storage);
      window.removeEventListener("kaikou-interview-records-changed", refresh);
    };
  }, [path]);
  useEffect(() => setTooltip(null), [path, collapsed, desktop]);
  const recent: RecentEntry[] = [
    ...sessions.slice(0, 4).map(session => ({
      id: `expression:${session.id}`, title: session.topic, path: `/record/${encodeURIComponent(session.id)}`,
      time: session.createdAt, kind: "expression" as const,
    })),
    ...sidebarRecords.records.slice(0, 4).map(record => ({
      id: `${record.kind}:${record.id}`, title: `${record.source?.role || "模拟面试"} · ${record.kind === "live" ? "LIVE 面试" : "逐题面试"}`,
      path: interviewRecordPath(record), time: record.time, kind: "interview" as const,
    })),
  ].sort((a, b) => b.time.localeCompare(a.time));
  if (sidebarRecords.pending) recent.unshift({
    id: "pending-interview", title: sidebarRecords.pending.title, path: sidebarRecords.pending.path,
    time: "", kind: "interview", pending: true,
  });
  const pageTitle = selected === "/settings" ? "设置与说明" : mainNavigation.find(item => item.path === selected)?.label || "我的练习";
  function toggleSidebar() {
    const next = !collapsed;
    setCollapsed(next);
    setPreferenceNotice("");
    try { localStorage.setItem(sidebarPreferenceKey, next ? "1" : "0"); }
    catch { setPreferenceNotice("侧栏偏好暂未保存，本次仍可使用。"); }
  }
  function tooltipProps(label: string) {
    const show = (event: { currentTarget: HTMLElement }) => {
      if (!collapsed || !desktop) return;
      const rect = event.currentTarget.getBoundingClientRect();
      setTooltip({ label, top: Math.max(8, rect.top + rect.height / 2 - 18), left: rect.right + 12 });
    };
    return {
      onMouseEnter: show,
      onFocus: show,
      onMouseLeave: () => setTooltip(null),
      onBlur: () => setTooltip(null),
      onKeyDown: (event: { key: string }) => { if (event.key === "Escape") setTooltip(null); },
      "aria-describedby": collapsed && tooltip?.label === label ? "agent-sidebar-tooltip" : undefined,
    };
  }
  return (
    <div className="desktop-frame agent-frame" data-sidebar-collapsed={collapsed}>
      <aside className="app-sidebar" hidden={!desktop}>
        <div className="agent-sidebar-heading">
          <a
            className="sidebar-brand"
            href="#/"
            onClick={(e) => {
              e.preventDefault();
              go("/");
            }}
            aria-label="开口首页"
            {...tooltipProps("开口首页")}
          >
            <Brand />
          </a>
          <button
            className="agent-sidebar-toggle"
            type="button"
            onClick={toggleSidebar}
            aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
            title={collapsed ? "展开侧栏" : "收起侧栏"}
            aria-expanded={!collapsed}
            aria-controls="agent-sidebar-navigation"
            {...tooltipProps(collapsed ? "展开侧栏" : "收起侧栏")}
          >
            <SidebarSimple size={20} weight="regular" aria-hidden="true" />
          </button>
        </div>
        <nav id="agent-sidebar-navigation" className="sidebar-nav" aria-label="桌面导航">
          {mainNavigation.map(({ path: to, label, icon: Icon }) => (
            <a
              key={to}
              href={`#${to}`}
              onClick={(e) => {
                e.preventDefault();
                go(to);
              }}
              className={selected === to ? "selected" : ""}
              aria-current={selected === to ? "page" : undefined}
              aria-label={label}
              title={label}
              {...tooltipProps(label)}
            >
              <Icon size={21} weight="regular" aria-hidden="true" />
              <span>{label}</span>
            </a>
          ))}
        </nav>
        <section className="agent-recent" aria-label="最近练习" hidden={collapsed}>
          <h2>最近练习</h2>
          {recent.slice(0, 4).map(entry => <a key={entry.id} href={`#${entry.path}`} title={entry.title}
            className={(window.location.hash.slice(1) || "/") === entry.path ? "selected" : ""}
            onClick={event => { event.preventDefault(); go(entry.path); }}>
            <ClockCounterClockwise size={16} aria-hidden="true" />
            <span><strong>{entry.title}</strong><small>{entry.pending ? "继续上次" : entry.kind === "expression" ? "表达练习" : "面试记录"}</small></span>
          </a>)}
          {sidebarRecords.error && <p className="agent-recent-error" role="status">{sidebarRecords.error}<a href="#/history" onClick={event => { event.preventDefault(); go("/history"); }}>查看练习记录</a></p>}
          {!recent.length && !sidebarRecords.error && <p className="agent-recent-empty">保存练习后，可从这里快速回看。</p>}
        </section>
        <div className="sidebar-bottom">
          <p className="sidebar-storage-note" aria-label="练习保存在本机" title="练习保存在本机"><ShieldCheck size={17} aria-hidden="true" /><span>练习保存在本机</span></p>
          <a
            href="#/settings"
            className={`sidebar-settings ${selected === "/settings" ? "selected" : ""}`}
            onClick={(e) => {
              e.preventDefault();
              go("/settings");
            }}
            aria-label="设置与服务状态"
            title="设置与服务状态"
            {...tooltipProps("设置与服务状态")}
          >
            <GearSix size={19} aria-hidden="true" />
            <span>设置与服务状态</span>
          </a>
          <small className="sidebar-version">
            {window.desktopApp ? "桌面版" : "网页版"} v{version}
          </small>
        </div>
      </aside>
      <div id="agent-sidebar-tooltip" className="agent-sidebar-tooltip" role="tooltip" hidden={!desktop || !collapsed || !tooltip} style={{ top: tooltip?.top, left: tooltip?.left }}>{tooltip?.label}</div>
      <div className="desktop-workspace">
        <div className="agent-workspace-bar" hidden={!desktop}>
          <nav aria-label="当前位置">
            <a href="#/" onClick={event => { event.preventDefault(); go("/"); }}>我的练习空间</a>
            <CaretRight size={14} aria-hidden="true" />
            <span aria-current="page">{pageTitle}</span>
          </nav>
          {preferenceNotice && <p role="status">{preferenceNotice}</p>}
        </div>
        {children}
      </div>
    </div>
  );
}
function readPendingInterview() {
  try {
    const live = localStorage.getItem("kaikou.interview.mode") === "live";
    const raw = localStorage.getItem(live ? "kaikou.live-interview.draft.v1" : "kaikou.interview.draft.v1");
    if (!raw) return null;
    const draft = JSON.parse(raw);
    const hasContent = live
      ? Array.isArray(draft.messages) && draft.messages.length > 0
      : Boolean(draft.question || draft.answer || draft.turns?.length);
    if (!hasContent || draft.report) return null;
    return { title: `${(live ? draft.source?.role : draft.role) || "模拟面试"} · ${live ? "LIVE 通话" : "逐题练习"}`, path: "/interview" };
  } catch { return null; }
}
export function DesktopHome({ sessions, error = "" }: { sessions: Session[]; error?: string }) {
  const pendingSession = sessions.find((session) => !session.feedback);
  const pending = readPendingInterview() || (pendingSession
    ? { title: pendingSession.topic, path: `/record/${encodeURIComponent(pendingSession.id)}` }
    : null);
  return (
    <main className="desktop-home today-home calm-home">
      <div className="desk-page-heading">
        <div>
          <h1>今天，你想练什么？</h1>
          <p>练清楚日常表达，也为下一场面试做好准备。</p>
        </div>
        <a href="#/settings" className="mobile-settings" aria-label="设置与服务状态" onClick={(e) => { e.preventDefault(); go("/settings"); }}><GearSix size={23} /></a>
      </div>
      {error && <p className="error-note" role="alert">{error}</p>}
      {pending && <section className="home-continue" aria-label="继续上次练习">
        <div><small>继续上次</small><strong>{pending.title}</strong></div>
        <button className="text-button" onClick={() => go(pending.path)}>继续练习 <ArrowRight size={18} /></button>
      </section>}
      <section className="home-core-choices" aria-label="选择练习方向">
        <article className="home-core-entry">
          <Microphone size={34} weight="regular" aria-hidden="true" />
          <h2>表达训练</h2>
          <p>把想法说清楚，把重点讲明白。</p>
          <span className="home-entry-context">即兴表达 · 场景沟通 · 复述练习</span>
          <button className="button primary" onClick={() => go("/practice/improv")}>开始表达训练 <ArrowRight size={18} /></button>
        </article>
        <article className="home-core-entry">
          <UserFocus size={34} weight="regular" aria-hidden="true" />
          <h2>模拟面试</h2>
          <p>带上真实经历，练出岗位需要的回答。</p>
          <span className="home-entry-context">简历与 JD · 逐题练习 · LIVE 通话</span>
          <button className="button primary" onClick={() => go("/interview")}>进入模拟面试 <ArrowRight size={18} /></button>
        </article>
      </section>
      <p className="home-quiet-note">想先学方法？在“方法学习”中查看表达框架与 21 天练习计划。</p>
    </main>
  );
}
