import { Suspense } from 'react';
import MissionControlLayout from '../../components/mission-control/MissionControlLayout';

export default function DashboardPage() {
  return (
    <Suspense>
      <MissionControlLayout />
    </Suspense>
  );
}
