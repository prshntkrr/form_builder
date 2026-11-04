import React from 'react'
import ResearchNav from './Nav.jsx'
import PlatformsList from './pages/PlatformsList.jsx'
import PlatformRegister from './pages/PlatformRegister.jsx'
import PlatformDetail from './pages/PlatformDetail.jsx'
import TrialsList from './pages/TrialsList.jsx'
import TrialRegister from './pages/TrialRegister.jsx'
import TrialDetail from './pages/TrialDetail.jsx'
import CycleProtocol from './pages/CycleProtocol.jsx'
import ObservationLog from './pages/ObservationLog.jsx'
import ResearchFormsList from './pages/ResearchFormsList.jsx'
import ResearchFormBuilder from './pages/ResearchFormBuilder.jsx'
import ResearchFormFill from './pages/ResearchFormFill.jsx'
import ResearchFormSubmissions from './pages/ResearchFormSubmissions.jsx'
import './styles.css'

export default {
  name: 'research_platforms',
  label: 'Research Platforms & Long-Term Trials',
  order: 8,
  Nav: ResearchNav,
  navItems: [],
  home: (can) => (can?.use_research_platforms ? '/research/platforms' : null),
  routes: [
    { path: '/research/platforms', element: <PlatformsList />, requires: 'use_research_platforms' },
    { path: '/research/platforms/new', element: <PlatformRegister />, requires: 'manage_research_platforms' },
    { path: '/research/platforms/:platformId', element: <PlatformDetail />, requires: 'use_research_platforms' },
    { path: '/research/platforms/:platformId/edit', element: <PlatformRegister />, requires: 'manage_research_platforms' },
    { path: '/research/trials', element: <TrialsList />, requires: 'use_research_platforms' },
    { path: '/research/trials/new', element: <TrialRegister />, requires: 'manage_research_platforms' },
    { path: '/research/trials/:trialId', element: <TrialDetail />, requires: 'use_research_platforms' },
    { path: '/research/trials/:trialId/edit', element: <TrialRegister />, requires: 'manage_research_platforms' },
    { path: '/research/cycles/:cycleId', element: <CycleProtocol />, requires: 'use_research_platforms' },
    { path: '/research/protocols/:protocolId/observations', element: <ObservationLog />, requires: 'use_research_platforms' },
    { path: '/research/forms', element: <ResearchFormsList />, requires: 'use_research_platforms' },
    { path: '/research/forms/new', element: <ResearchFormBuilder />, requires: 'manage_research_platforms' },
    { path: '/research/forms/:formId/edit', element: <ResearchFormBuilder />, requires: 'manage_research_platforms' },
    { path: '/research/forms/:formId/fill', element: <ResearchFormFill />, requires: 'use_research_platforms' },
    { path: '/research/forms/:formId/submissions', element: <ResearchFormSubmissions />, requires: 'use_research_platforms' },
  ],
}
