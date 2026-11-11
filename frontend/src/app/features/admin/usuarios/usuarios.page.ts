import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { AuthService } from '../../../core/auth.service';
import { ESTILOS_ADMIN } from '../../../shared/estilos-admin';
import { Catalogo, UsuarioAdmin, UsuarioCambios, UsuariosService } from './usuarios.service';

const ROLES = [
  { id: 'admin', nombre: 'Administrador' },
  { id: 'cotizador', nombre: 'Cotizador' },
  { id: 'visualizador', nombre: 'Visualizador' },
];

@Component({
  selector: 'app-usuarios',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap">
      <div class="cab">
        <div>
          <span class="eyebrow">Mi empresa</span>
          <h2>Usuarios</h2>
          <p class="sub">Crea usuarios, asigna su rol y marca a qué módulos y acciones tienen acceso.</p>
        </div>
        <div class="cupo">
          @if (catalogo(); as c) { <span class="sub">Usuarios: {{ c.usados }} / {{ c.cupo }}</span> }
          <button class="btn primary" [disabled]="sinCupo()" (click)="nuevo()">+ Nuevo usuario</button>
        </div>
      </div>

      @if (error()) { <p class="error">{{ error() }}</p> }

      <div class="tabla-wrap">
        <table class="tabla">
          <thead>
            <tr><th>Usuario</th><th>Nombre</th><th>Rol</th><th>Accesos</th><th>Estado</th><th></th></tr>
          </thead>
          <tbody>
            @for (u of usuarios(); track u.id) {
              <tr [class.off]="!u.activo">
                <td><b>{{ u.usuario }}</b></td>
                <td>{{ u.nombre }}</td>
                <td><span class="rol r-{{ u.rol }}">{{ rolNombre(u.rol) }}</span></td>
                <td class="acc">{{ u.rol === 'admin' ? 'Acceso total' : resumen(u) }}</td>
                <td>{{ u.activo ? 'Activo' : 'Desactivado' }}</td>
                <td class="btns">
                  <button class="btn" (click)="editar(u)">Editar</button>
                  @if (u.id !== auth.usuario()?.id) {
                    <button class="btn" (click)="alternarActivo(u)">{{ u.activo ? 'Desactivar' : 'Activar' }}</button>
                  }
                </td>
              </tr>
            } @empty {
              <tr><td colspan="6" class="vacio">{{ cargando() ? 'Cargando…' : 'Sin usuarios' }}</td></tr>
            }
          </tbody>
        </table>
      </div>
    </div>

    @if (abierto()) {
      <div class="overlay" (click)="cerrar()">
        <form class="modal" (click)="$event.stopPropagation()" (submit)="$event.preventDefault(); guardar()">
          <h3>{{ editId() === null ? 'Nuevo usuario' : 'Editar usuario' }}</h3>

          <div class="grid2">
            <label>Usuario
              <input type="text" autocomplete="off" [value]="fUsuario()" [disabled]="editId() !== null"
                     (input)="fUsuario.set($any($event.target).value)" />
            </label>
            <label>Nombre
              <input type="text" autocomplete="off" [value]="fNombre()" (input)="fNombre.set($any($event.target).value)" />
            </label>
            <label>{{ editId() === null ? 'Clave' : 'Nueva clave (opcional)' }}
              <input type="password" autocomplete="new-password" [value]="fClave()"
                     (input)="fClave.set($any($event.target).value)" />
              <small>Mínimo 10 caracteres, con letras y números.</small>
            </label>
            <label>Rol
              <select [disabled]="fRol() === 'admin'" (change)="cambiarRol($any($event.target).value)">
                @for (r of roles; track r.id) {
                  @if (r.id !== 'admin' || fRol() === 'admin') {
                    <option [value]="r.id" [selected]="fRol() === r.id">{{ r.nombre }}</option>
                  }
                }
              </select>
            </label>
          </div>

          @if (catalogo(); as cat) {
            <h4>Permisos</h4>
            @if (esAdminRol()) {
              <p class="nota">El administrador tiene acceso total a todos los módulos y a la gestión de usuarios.</p>
            } @else {
              <p class="nota">Al elegir un rol se marcan sus permisos habituales; puedes ajustarlos.</p>
            }
            <table class="matriz">
              <thead>
                <tr>
                  <th>Módulo</th>
                  @for (a of cat.acciones; track a.id) { <th>{{ a.nombre }}</th> }
                </tr>
              </thead>
              <tbody>
                @for (m of cat.modulos; track m.id) {
                  <tr>
                    <td>{{ m.nombre }}</td>
                    @for (a of cat.acciones; track a.id) {
                      <td>
                        <input type="checkbox" [disabled]="esAdminRol()"
                               [checked]="esAdminRol() || tiene(m.id + ':' + a.id)"
                               (change)="toggle(m.id + ':' + a.id, $any($event.target).checked)" />
                      </td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          }

          @if (errorForm()) { <p class="error">{{ errorForm() }}</p> }

          <div class="pie">
            <button type="button" class="btn" (click)="cerrar()">Cancelar</button>
            <button type="submit" class="btn primary" [disabled]="guardando()">
              {{ guardando() ? 'Guardando…' : 'Guardar' }}
            </button>
          </div>
        </form>
      </div>
    }
  `,
  styles: [ESTILOS_ADMIN],
})
export class UsuariosPage implements OnInit {
  private readonly api: UsuariosService = inject(UsuariosService);
  readonly auth: AuthService = inject(AuthService);
  readonly roles = ROLES;

  readonly usuarios = signal<UsuarioAdmin[]>([]);
  readonly catalogo = signal<Catalogo | null>(null);
  readonly cargando = signal<boolean>(false);
  readonly error = signal<string>('');

  readonly abierto = signal<boolean>(false);
  readonly guardando = signal<boolean>(false);
  readonly errorForm = signal<string>('');
  readonly editId = signal<number | null>(null);
  readonly fUsuario = signal<string>('');
  readonly fNombre = signal<string>('');
  readonly fClave = signal<string>('');
  readonly fRol = signal<string>('visualizador');
  readonly fPermisos = signal<Set<string>>(new Set<string>());
  readonly esAdminRol = computed<boolean>(() => this.fRol() === 'admin');
  readonly sinCupo = computed<boolean>(() => {
    const c = this.catalogo();
    return !!c && c.usados >= c.cupo;
  });

  ngOnInit(): void {
    this.api.catalogo().subscribe({
      next: (c) => this.catalogo.set(c),
      error: (e: HttpErrorResponse) => this.error.set(this.msg(e)),
    });
    this.cargar();
  }

  cargar(): void {
    this.api.catalogo().subscribe({ next: (c) => this.catalogo.set(c), error: () => undefined });
    this.cargando.set(true);
    this.api.listar().subscribe({
      next: (l) => { this.usuarios.set(l); this.cargando.set(false); },
      error: (e: HttpErrorResponse) => { this.error.set(this.msg(e)); this.cargando.set(false); },
    });
  }

  rolNombre(id: string): string { return ROLES.find((r) => r.id === id)?.nombre ?? id; }

  resumen(u: UsuarioAdmin): string {
    const cat = this.catalogo();
    if (!cat) return '';
    const partes = cat.modulos
      .map((m) => {
        const acc = cat.acciones.filter((a) => u.permisos.includes(`${m.id}:${a.id}`)).map((a) => a.id);
        return acc.length ? `${m.nombre} (${acc.join(', ')})` : '';
      })
      .filter(Boolean);
    return partes.length ? partes.join(' · ') : 'Sin accesos';
  }

  nuevo(): void {
    this.editId.set(null);
    this.fUsuario.set(''); this.fNombre.set(''); this.fClave.set('');
    this.cambiarRol('visualizador');
    this.errorForm.set('');
    this.abierto.set(true);
  }

  editar(u: UsuarioAdmin): void {
    this.editId.set(u.id);
    this.fUsuario.set(u.usuario); this.fNombre.set(u.nombre ?? ''); this.fClave.set('');
    this.fRol.set(u.rol);
    this.fPermisos.set(new Set(u.permisos));
    this.errorForm.set('');
    this.abierto.set(true);
  }

  cerrar(): void { this.abierto.set(false); }

  cambiarRol(rol: string): void {
    this.fRol.set(rol);
    this.fPermisos.set(new Set(this.catalogo()?.roles[rol] ?? []));
  }

  tiene(p: string): boolean { return this.fPermisos().has(p); }

  toggle(p: string, marcado: boolean): void {
    const s = new Set(this.fPermisos());
    const [mod, acc] = p.split(':');
    if (marcado) {
      s.add(p); s.add(`${mod}:ver`);
    } else {
      s.delete(p);
      if (acc === 'ver') { s.delete(`${mod}:archivos`); s.delete(`${mod}:cotizar`); }
    }
    this.fPermisos.set(s);
  }

  guardar(): void {
    if (this.guardando()) return;
    this.errorForm.set('');
    const permisos = this.esAdminRol() ? [] : [...this.fPermisos()];
    this.guardando.set(true);

    const ok = () => { this.guardando.set(false); this.cerrar(); this.cargar(); };
    const fallo = (e: HttpErrorResponse) => { this.guardando.set(false); this.errorForm.set(this.msg(e)); };

    const id = this.editId();
    if (id === null) {
      this.api.crear({
        usuario: this.fUsuario().trim(), nombre: this.fNombre().trim(),
        clave: this.fClave(), rol: this.fRol(), permisos,
      }).subscribe({ next: ok, error: fallo });
    } else {
      const cambios: UsuarioCambios = { nombre: this.fNombre().trim(), rol: this.fRol(), permisos };
      if (this.fClave()) cambios.clave = this.fClave();
      this.api.editar(id, cambios).subscribe({ next: ok, error: fallo });
    }
  }

  alternarActivo(u: UsuarioAdmin): void {
    const accion = u.activo ? 'desactivar' : 'activar';
    if (!confirm(`¿Seguro que quieres ${accion} a ${u.usuario}?`)) return;
    this.api.editar(u.id, { activo: !u.activo }).subscribe({
      next: () => this.cargar(),
      error: (e: HttpErrorResponse) => this.error.set(this.msg(e)),
    });
  }

  private msg(e: HttpErrorResponse): string {
    const d = e.error?.detail;
    if (typeof d === 'string') return d;
    if (Array.isArray(d)) return 'Revisa los datos: usuario (3+ caracteres, sin espacios) y clave (10+ caracteres).';
    return 'No se pudo conectar con el servidor';
  }
}