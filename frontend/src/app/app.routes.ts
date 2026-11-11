import { Route, Routes } from '@angular/router';
import {
  adminGuard, asesorGuard, authGuard, inicioGuard, permisoGuard, soloVisitante, superadminGuard, titularGuard,
} from './core/auth.guard';

const proximamente = () => import('./shared/proximamente.component').then((m) => m.ProximamenteComponent);

/** Capacitación de un módulo: catálogo de cursos y reproductor. */
const capacitacion = (modulo: string): Route[] => [
  {
    path: 'capacitacion',
    loadComponent: () => import('./features/aprende/catalogo.page').then((m) => m.CatalogoCursosPage),
    data: { modulo },
  },
  {
    path: 'capacitacion/:curso',
    loadComponent: () => import('./features/aprende/curso.page').then((m) => m.CursoPage),
    data: { modulo },
  },
];

/** Servicios contratados de un módulo: avance, sesiones y calendario. */
const servicios = (modulo: string): Route[] => [
  {
    path: 'servicios',
    loadComponent: () => import('./features/cuenta/servicios-modulo.page').then((m) => m.ServiciosModuloPage),
    data: { modulo },
  },
];

/** Módulos que aún no tienen pantallas de contrataciones: la entrada es Capacitación. */
const enConstruccion = (id: string, nombre: string): Route => ({
  path: id,
  canActivate: [permisoGuard(`${id}:ver`)],
  children: [
    { path: '', pathMatch: 'full', redirectTo: 'capacitacion' },
    ...capacitacion(id),
    ...servicios(id),
    { path: 'contrataciones', loadComponent: proximamente, data: { titulo: `${nombre}: Contrataciones` } },
    {
      path: 'asignaciones',
      canActivate: [permisoGuard(`${id}:cotizar`)],
      loadComponent: proximamente,
      data: { titulo: `${nombre}: Mis asignaciones` },
    },
  ],
});

export const routes: Routes = [
  {
    path: 'comprar',
    canMatch: [soloVisitante],
    loadComponent: () => import('./features/publico/checkout.page').then((m) => m.CheckoutPage),
  },
  {
    path: 'terminos',
    loadComponent: () => import('./features/publico/legal.page').then((m) => m.LegalPage),
    data: { tipo: 'terminos' },
  },
  {
    path: 'privacidad',
    loadComponent: () => import('./features/publico/legal.page').then((m) => m.LegalPage),
    data: { tipo: 'privacidad' },
  },
  {
    path: 'solicitar',
    loadComponent: () => import('./features/publico/solicitud.page').then((m) => m.SolicitudPage),
  },
  {
    path: 'crear-clave',
    loadComponent: () => import('./features/publico/crear-clave.page').then((m) => m.CrearClavePage),
  },
  {
    path: 'verificar',
    canMatch: [soloVisitante],
    loadComponent: () => import('./features/auth/verificar.page').then((m) => m.VerificarPage),
  },
  {
    path: 'login',
    loadComponent: () => import('./features/auth/login/login.component').then((m) => m.LoginComponent),
  },
  {
    path: '',
    pathMatch: 'full',
    canMatch: [soloVisitante],
    loadComponent: () => import('./features/publico/inicio.page').then((m) => m.InicioPage),
  },
  {
    path: '',
    loadComponent: () => import('./layout/shell.component').then((m) => m.ShellComponent),
    canActivate: [authGuard],
    children: [
      { path: '', pathMatch: 'full', canActivate: [inicioGuard], children: [] },
      {
        path: 'sin-acceso',
        loadComponent: proximamente,
        data: { titulo: 'Sin módulos habilitados', mensaje: 'Pide al administrador que te habilite un módulo.' },
      },

      {
        // Seguridad de la cuenta (todos los usuarios)
        path: 'seguridad',
        loadComponent: () => import('./features/auth/seguridad.page').then((m) => m.SeguridadPage),
      },

      {
        path: 'menor',
        canActivate: [permisoGuard('menor:ver')],
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'contrataciones' },
          {
            path: 'contrataciones',
            loadComponent: () =>
              import('./features/coti-menor/contrataciones/contrataciones.page').then((m) => m.ContratacionesPage),
          },
          ...capacitacion('menor'),
          ...servicios('menor'),
          {
            path: 'asignaciones',
            canActivate: [permisoGuard('menor:cotizar')],
            loadComponent: () =>
              import('./features/coti-menor/asignaciones/asignaciones.page').then((m) => m.AsignacionesPage),
          },
        ],
      },
      {
        path: 'mayor',
        canActivate: [permisoGuard('mayor:ver')],
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'contrataciones' },
          {
            path: 'contrataciones',
            loadComponent: () =>
              import('./features/coti-mayor/licitaciones/licitaciones.page').then((m) => m.LicitacionesPage),
          },
          ...capacitacion('mayor'),
          {
            path: 'asignaciones',
            canActivate: [permisoGuard('mayor:cotizar')],
            loadComponent: proximamente,
            data: { titulo: 'Coti Mayor: Mis asignaciones' },
          },
        ],
      },
      enConstruccion('perucompras', 'Perú Compras'),

      {
        path: 'mi-agenda',
        canActivate: [asesorGuard],
        loadComponent: () => import('./features/agenda/mi-agenda.page').then((m) => m.MiAgendaPage),
      },
      {
        path: 'crm-admin',
        canActivate: [superadminGuard],
        loadComponent: () => import('./features/crm/crm-admin.page').then((m) => m.CrmAdminPage),
      },
      {
        path: 'ventas-admin',
        canActivate: [superadminGuard],
        loadComponent: () => import('./features/plataforma/ventas-admin.page').then((m) => m.VentasAdminPage),
      },
      {
        path: 'avisos-admin',
        canActivate: [superadminGuard],
        loadComponent: () => import('./features/plataforma/avisos-admin.page').then((m) => m.AvisosAdminPage),
      },
      {
        path: 'legal-admin',
        canActivate: [superadminGuard],
        loadComponent: () => import('./features/plataforma/legal-admin.page').then((m) => m.LegalAdminPage),
      },
      {
        path: 'agenda-admin',
        canActivate: [superadminGuard],
        loadComponent: () => import('./features/agenda/agenda-admin.page').then((m) => m.AgendaAdminPage),
      },
      {
        path: 'anuncios-admin',
        canActivate: [superadminGuard],
        loadComponent: () => import('./features/anuncios/anuncios-admin.page').then((m) => m.AnunciosAdminPage),
      },
      {
        path: 'cursos-admin',
        canActivate: [superadminGuard],
        loadComponent: () => import('./features/aprende/cursos-admin.page').then((m) => m.CursosAdminPage),
      },
      {
        path: 'pedidos',
        canActivate: [superadminGuard],
        loadComponent: () => import('./features/plataforma/pedidos.page').then((m) => m.PedidosPage),
      },
      {
        path: 'cuenta',
        canActivate: [titularGuard],
        loadComponent: () => import('./features/cuenta/cuenta.page').then((m) => m.CuentaPage),
      },
      {
        path: 'catalogo',
        canActivate: [superadminGuard],
        loadComponent: () => import('./features/plataforma/catalogo.page').then((m) => m.CatalogoPage),
      },
      {
        path: 'plataforma',
        canActivate: [superadminGuard],
        loadComponent: () => import('./features/plataforma/plataforma.page').then((m) => m.PlataformaPage),
      },
      {
        path: 'admin',
        canActivate: [adminGuard],
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'usuarios' },
          {
            path: 'usuarios',
            loadComponent: () => import('./features/admin/usuarios/usuarios.page').then((m) => m.UsuariosPage),
          },
        ],
      },
    ],
  },
  { path: '**', redirectTo: '' },
];