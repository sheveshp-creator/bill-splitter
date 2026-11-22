import { lazy, Suspense, useEffect } from 'react'
import { Route, Routes } from 'react-router-dom'
import { ToastProvider } from './components/ui'
import { startSync } from './sync/engine'
import Home from './pages/Home'
import Join from './pages/Join'

const GroupPage = lazy(() => import('./pages/Group'))
const ExpenseForm = lazy(() => import('./pages/ExpenseForm'))

export default function App() {
  useEffect(() => { startSync() }, [])
  return (
    <ToastProvider>
      <div className="mx-auto max-w-xl min-h-screen pb-24">
        <Suspense fallback={<p className="p-6 muted" role="status">Loading…</p>}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/join/:token" element={<Join />} />
            <Route path="/g/:id" element={<GroupPage />} />
            <Route path="/g/:id/expense/new" element={<ExpenseForm />} />
            <Route path="/g/:id/expense/:eid" element={<ExpenseForm />} />
            <Route path="*" element={<Home />} />
          </Routes>
        </Suspense>
      </div>
    </ToastProvider>
  )
}
