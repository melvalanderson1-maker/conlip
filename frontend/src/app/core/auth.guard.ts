import { inject } from '@angular/core';
import { CanActivateFn, CanMatchFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

export const authGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.logueado() ? true : router.createUrlTree(['/login']);
};

export const permisoGuard = (permiso: string): CanActivateFn => () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.puede(permiso) ? true : router.createUrlTree(['/']);
};

export const adminGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.esAdmin() ? true : router.createUrlTree(['/']);
};

/** Ruta '/': manda al primer módulo permitido, o a /sin-acceso si no tiene ninguno. */
export const inicioGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return router.createUrlTree(auth.primeraRuta() ?? ['/sin-acceso']);
};


export const superadminGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.esSuperadmin() ? true : router.createUrlTree(['/']);
};


/** La portada pública solo se muestra a quien no ha iniciado sesión. */
export const soloVisitante: CanMatchFn = () => !inject(AuthService).logueado();



export const titularGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.esTitular() ? true : router.createUrlTree(['/']);
};


export const asesorGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.esAsesor() ? true : router.createUrlTree(['/']);
};



/** Ejecutivos de ventas y asesores (quien sea ejecutivo también). El backend valida si de verdad lo es. */
export const ejecutivoGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.esEjecutivo() || auth.esAsesor() ? true : router.createUrlTree(['/']);
};