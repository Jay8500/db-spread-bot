import { Routes } from '@angular/router';
import { authGuard, guestGuard } from './core/auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    canActivate: [guestGuard],
    loadComponent: () => import('./pages/login/login').then((m) => m.Login),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./shell/app-shell').then((m) => m.AppShell),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'query' },
      { path: 'query', loadComponent: () => import('./pages/query/query').then((m) => m.Query) },
      { path: 'projects', loadComponent: () => import('./pages/projects/projects').then((m) => m.Projects) },
      { path: 'connect/callback', loadComponent: () => import('./pages/connect/connect-callback').then((m) => m.ConnectCallback) },
      { path: 'activity', loadComponent: () => import('./pages/log/activity-log').then((m) => m.ActivityLog) },
    ],
  },
  { path: '**', redirectTo: '' },
];
