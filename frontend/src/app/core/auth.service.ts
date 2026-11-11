import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { API } from './api';

export type Rol = 'superadmin' | 'admin' | 'cotizador' | 'visualizador' | 'asesor';
export interface UsuarioSesion {
  id: number; usuario: string; nombre: string; rol: Rol; permisos: string[];
  empresa: { id: number; nombre: string; tipo: 'empresa' | 'persona' } | null;
  dos_pasos?: boolean;
  debe_activar_2fa?: boolean;
}
interface LoginRes { token: string; usuario: UsuarioSesion; requiere_2fa?: boolean; ticket?: string; }

import { Router } from '@angular/router';
import { EMPTY, mergeMap, of } from 'rxjs';

const KEY_TOKEN = 'coti_token';
const KEY_USER = 'coti_user';
const MODULOS_ORDEN = ['menor', 'mayor', 'perucompras'] as const;

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http: HttpClient = inject(HttpClient);
  private readonly router: Router = inject(Router);
  /** Comprobante de 5 minutos tras acertar la clave. Vive solo en memoria: si recargas la página, vuelves a iniciar sesión. */
  readonly ticket2fa = signal<string | null>(null);

  readonly token = signal<string | null>(this.leer(KEY_TOKEN));
  readonly usuario = signal<UsuarioSesion | null>(this.leerUsuario());
  readonly logueado = computed<boolean>(() => !!this.token());
  readonly esAdmin = computed<boolean>(() => this.usuario()?.rol === 'admin');
  readonly esSuperadmin = computed<boolean>(() => this.usuario()?.rol === 'superadmin');
  readonly esAsesor = computed<boolean>(() => this.usuario()?.rol === 'asesor');
  /** Titular: admin de una empresa o persona natural dueña de su cuenta. */
  readonly esTitular = computed<boolean>(() => {
    const u = this.usuario();
    return !!u && !!u.empresa && (u.rol === 'admin' || u.empresa.tipo === 'persona');
  });
  private readonly permisos = computed<Set<string>>(() => new Set(this.usuario()?.permisos ?? []));

  /** Solo para mostrar/ocultar cosas. La seguridad real la valida el backend. */
  puede(permiso: string): boolean {
    return this.permisos().has(permiso);
  }

  /** Primera ruta de módulo a la que el usuario tiene acceso, o null si no tiene ninguna. */
  primeraRuta(): string[] | null {
    if (this.usuario()?.debe_activar_2fa) return ['/seguridad'];
    if (this.esSuperadmin()) return ['/plataforma'];
    if (this.esAsesor()) return ['/mi-agenda'];
    const m = MODULOS_ORDEN.find((x) => this.puede(`${x}:ver`));
    return m ? ['/', m] : null;
  }

  login(usuario: string, clave: string): Observable<LoginRes> {
    return this.http.post<LoginRes>(`${API}/auth/login`, { usuario, clave }).pipe(
      mergeMap((r: LoginRes) => {
        if (r.requiere_2fa && r.ticket) {
          // Falta el código de la app: no se emite resultado de login y se pasa a la pantalla de verificación
          this.ticket2fa.set(r.ticket);
          void this.router.navigate(['/verificar']);
          return EMPTY;
        }
        this.guardarToken(r.token);
        this.guardarUsuario(r.usuario);
        return of(r);
      }),
    );
  }

  /** Segundo paso: canjea el comprobante por la sesión con el código de la app o uno de respaldo. */
  verificar2fa(codigo: string): Observable<LoginRes> {
    return this.http.post<LoginRes>(`${API}/auth/2fa/verificar`, { ticket: this.ticket2fa(), codigo }).pipe(
      tap((r: LoginRes) => {
        this.ticket2fa.set(null);
        this.guardarToken(r.token);
        this.guardarUsuario(r.usuario);
      }),
    );
  }

  /** Vuelve a pedir rol y permisos al servidor (por si el admin los cambió). */
  refrescar(): Observable<UsuarioSesion> {
    return this.http.get<UsuarioSesion>(`${API}/auth/yo`).pipe(tap((u) => this.guardarUsuario(u)));
  }

  salir(): void {
    try {
      sessionStorage.removeItem(KEY_TOKEN);
      sessionStorage.removeItem(KEY_USER);
    } catch { /* nada */ }
    this.token.set(null);
    this.usuario.set(null);
  }

  private guardarToken(t: string): void {
    try { sessionStorage.setItem(KEY_TOKEN, t); } catch { /* dura hasta recargar */ }
    this.token.set(t);
  }

  private guardarUsuario(u: UsuarioSesion): void {
    try { sessionStorage.setItem(KEY_USER, JSON.stringify(u)); } catch { /* nada */ }
    this.usuario.set(u);
  }

  private leer(k: string): string | null {
    try { return sessionStorage.getItem(k); } catch { return null; }
  }

  private leerUsuario(): UsuarioSesion | null {
    try {
      const s = sessionStorage.getItem(KEY_USER);
      return s ? (JSON.parse(s) as UsuarioSesion) : null;
    } catch { return null; }
  }
}