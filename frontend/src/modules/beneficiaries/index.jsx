import React from 'react'
import BeneficiaryTypes from './pages/BeneficiaryTypes.jsx'
import MasterRegistry from './pages/MasterRegistry.jsx'

export default {
  name: 'beneficiaries',
  label: 'Beneficiaries',
  order: 55,
  routes: [
    { path: '/beneficiaries/types', element: <BeneficiaryTypes />, requires: 'view_beneficiaries' },
    { path: '/beneficiaries/registry', element: <MasterRegistry />, requires: 'view_beneficiaries' },
  ],
  navItems: [
    { group: 'administration', label: 'Beneficiary Types', to: '/beneficiaries/types', requires: 'manage_beneficiaries', icon: 'beneficiaries', order: 820 },
    { group: 'administration', label: 'Master Registry', to: '/beneficiaries/registry', requires: 'view_beneficiaries', icon: 'beneficiaries', order: 821 },
  ],
}
