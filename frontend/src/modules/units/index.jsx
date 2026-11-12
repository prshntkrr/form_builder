import React from 'react'
import Units from './pages/Units.jsx'

export default {
  name: 'units',
  label: 'Units',
  order: 50,
  routes: [
    { path: '/units', element: <Units />, requires: 'convert_units' },
  ],
  navItems: [
    { group: 'configuration', label: 'Units', to: '/units', requires: 'manage_units', icon: 'units', order: 815 },
  ],
}
