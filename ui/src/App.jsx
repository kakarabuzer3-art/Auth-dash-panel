import { AnimatePresence, motion, MotionConfig } from 'framer-motion';
import { AppProvider, useApp } from './store/AppContext.jsx';
import Sidebar from './components/Sidebar.jsx';
import Topbar from './components/Topbar.jsx';
import Toasts from './components/Toasts.jsx';
import Dashboard from './views/Dashboard.jsx';
import Scheduler from './views/Scheduler.jsx';
import ApiKeys from './views/ApiKeys.jsx';
import AiChat from './views/AiChat.jsx';
import AiSettings from './views/AiSettings.jsx';
import Skills from './views/Skills.jsx';
import Prompts from './views/Prompts.jsx';
import VsCode from './views/VsCode.jsx';
import Logs from './views/Logs.jsx';
import Settings from './views/Settings.jsx';
import Placeholder from './views/Placeholder.jsx';

const VIEWS = {
  dashboard: Dashboard,
  scheduler: Scheduler,
  apikeys: ApiKeys,
  aichat: AiChat,
  aisettings: AiSettings,
  skills: Skills,
  prompts: Prompts,
  vscode: VsCode,
  logs: Logs,
  settings: Settings,
};

function Shell() {
  const { view } = useApp();
  const Active = VIEWS[view] || Dashboard;
  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <Sidebar />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <Topbar />
        <main style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
          <AnimatePresence mode="wait">
            <motion.div key={view}
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.18 }}>
              <Active />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
      <Toasts />
    </div>
  );
}

export default function App() {
  // MotionConfig reducedMotion="user" honors the OS "reduce motion" setting
  // for ALL framer-motion animations (accessibility + psychology).
  return (
    <MotionConfig reducedMotion="user">
      <AppProvider>
        <Shell />
      </AppProvider>
    </MotionConfig>
  );
}
