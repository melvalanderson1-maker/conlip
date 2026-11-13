import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ESTILOS_ADMIN } from '../../shared/estilos-admin';
import { IconComponent } from '../../shared/icon.component';
import { AsesorLibre, CrmService, Ejecutivo } from './crm.service';

interface EdEjecutivo {
  id: number | null; nombre: string; correo: string; telefono: string; color: string; activo: boolean;
  recibeLeads: boolean; asesorId: number | null; usuarioId: number | null; leadsAbiertos: number;
}

@Component({
  selector: 'app-crm-ejecutivos',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (mensaje()) { <p class="ok"><app-icon name="circle-check" [size]="18" /> {{ mensaje() }}</p> }
    @if (error()) { <p class="error"><app-icon name="alert" [size]="18" /> {{ error() }}</p> }

    <div class="barra-sup">
      <p class="nota">Tu equipo de ventas recibe los leads del CRM. Una persona puede ser a la vez asesor de la agenda (vincúlala al editar) y ejecutivo de ventas.</p>
      <button type="button" class="btn primary" (click)="nuevo()"><app-icon name="plus" [size]="16" /> Nuevo ejecutivo</button>
    </div>

    <div class="eq">
      @for (e of lista(); track e.id) {
        <article class="ej" [class.off]="!e.activo">
          <span class="av" [style.background]="e.color">{{ iniciales(e.nombre) }}</span>
          <div class="ej-t">
            <h3>{{ e.nombre }}</h3>
            <small>{{ e.correo || 'Sin correo' }}</small>
            <div class="tags">
              @if (!e.activo) { <span class="tag">Inactivo</span> }
              @else if (!e.recibe_leads) { <span class="tag aviso">Reparto en pausa</span> }
              @if (e.asesor_id) { <span class="tag">También asesor</span> }
              @if (e.tiene_acceso) { <span class="tag si">Con acceso</span> } @else { <span class="tag aviso">Sin acceso</span> }
            </div>
            <small>{{ e.leads_abiertos }} leads abiertos · {{ e.ganados_mes }} ganados este mes</small>
          </div>
          <button type="button" class="btn" (click)="editar(e)"><app-icon name="pencil" [size]="15" /> Editar</button>
        </article>
      } @empty {
        <div class="vacio-b"><app-icon name="users" [size]="34" /><p>Aún no hay ejecutivos de ventas. Crea el primero para repartir leads.</p></div>
      }
    </div>

    @if (ed(); as a) {
      <div class="overlay" (click)="cerrar()">
        <div class="modal ancho" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
          <header class="m-cab">
            <h3>{{ a.id === null ? 'Nuevo ejecutivo de ventas' : 'Editar ejecutivo' }}</h3>
            <button type="button" class="btn ico" aria-label="Cerrar" (click)="cerrar()"><app-icon name="x" [size]="18" /></button>
          </header>
          <div class="grid2">
            <label>Nombre <input [value]="a.nombre" (input)="setEd({ nombre: $any($event.target).value })" /></label>
            <label>Correo (recibe la invitación al CRM)
              <input type="email" [value]="a.correo" (input)="setEd({ correo: $any($event.target).value })" />
            </label>
            <label>Teléfono <input [value]="a.telefono" (input)="setEd({ telefono: $any($event.target).value })" /></label>
            <label>Color <input type="color" [value]="a.color" (input)="setEd({ color: $any($event.target).value })" /></label>
            <label>¿También es asesor de la agenda?
              <select (change)="setEd({ asesorId: $any($event.target).value ? +$any($event.target).value : null })">
                <option value="" [selected]="a.asesorId === null">No, solo ejecutivo de ventas</option>
                @for (o of opcionesAsesor(); track o.id) {
                  <option [value]="o.id" [selected]="a.asesorId === o.id">{{ o.nombre }}</option>
                }
              </select>
            </label>
            <label class="chk"><input type="checkbox" [checked]="a.activo" (change)="setEd({ activo: $any($event.target).checked })" /> Activo</label>
            <label class="chk"><input type="checkbox" [checked]="a.recibeLeads" (change)="setEd({ recibeLeads: $any($event.target).checked })" /> Recibe leads nuevos (desmárcalo para pausar el reparto)</label>
          </div>

          @if (a.id !== null) {
            <section class="acceso">
              <div>
                <b>Acceso al CRM</b>
                <small>
                  @if (a.usuarioId) { Tiene usuario y entra a su CRM con sus leads. }
                  @else { Sin acceso. Guarda sus datos y el correo antes de darle acceso. }
                </small>
              </div>
              <div class="fila">
                <button type="button" class="btn primary" (click)="darAcceso()">{{ a.usuarioId ? 'Reenviar invitación' : 'Dar acceso' }}</button>
                @if (a.usuarioId) { <button type="button" class="btn peligro" (click)="quitarAcceso()">Quitar acceso</button> }
              </div>
            </section>

            <section class="acceso">
              <div>
                <b>Traspasar sus leads abiertos ({{ a.leadsAbiertos }})</b>
                <small>Úsalo cuando alguien se va o se va de vacaciones. Queda registrado en cada lead.</small>
              </div>
              <div class="fila">
                <select (change)="destino.set($any($event.target).value)">
                  <option value="" [selected]="destino() === ''">Elige el destino…</option>
                  @for (d of destinos(); track d.id) { <option [value]="d.id">{{ d.nombre }}</option> }
                  <option value="0">Dejar sin asignar</option>
                </select>
                <button type="button" class="btn" [disabled]="destino() === '' || a.leadsAbiertos === 0" (click)="traspasar()">Traspasar</button>
              </div>
            </section>
          }

          <div class="pie">
            @if (a.id !== null) { <button type="button" class="btn peligro" (click)="borrar()"><app-icon name="trash" [size]="15" /> Eliminar</button> }
            <button type="button" class="btn primary" (click)="guardar()">{{ a.id === null ? 'Crear ejecutivo' : 'Guardar datos' }}</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [ESTILOS_ADMIN, `
    .barra-sup { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 14px; }
    .barra-sup .nota { margin: 0; max-width: 640px; }
    .eq { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 16px; }
    .ej { display: flex; align-items: center; gap: 16px; padding: 18px; background: #fff; border: 1px solid var(--line); border-radius: 16px; }
    .ej.off { opacity: .6; }
    .av { display: grid; place-items: center; width: 52px; height: 52px; border-radius: 14px; color: #fff; font-weight: 700; flex: none; }
    .ej-t { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .ej-t h3 { margin: 0; } .ej-t small { color: var(--muted); }
    .tags { display: flex; gap: 6px; flex-wrap: wrap; margin: 2px 0; }
    .tag { padding: 2px 9px; border-radius: 999px; background: #e8edf8; color: #334155; font-size: .72rem; font-weight: 600; }
    .tag.si { background: #dcfce7; color: #047857; } .tag.aviso { background: #fef3c7; color: #b45309; }
    .vacio-b { grid-column: 1 / -1; display: grid; justify-items: center; gap: 8px; padding: 50px 20px; color: var(--muted); background: #fff; border: 1px dashed #c3cde6; border-radius: 16px; }
    .vacio-b p { margin: 0; }
    .modal.ancho { width: min(720px, 100%); } .m-cab { display: flex; justify-content: space-between; align-items: center; }
    .acceso { display: flex; justify-content: space-between; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 14px; padding: 14px 16px; background: #f8faff; border: 1px solid #c7d6fb; border-radius: 14px; }
    .acceso > div:first-child { display: flex; flex-direction: column; gap: 3px; max-width: 420px; } .acceso small { color: var(--muted); }
  `],
})
export class CrmEjecutivosComponent implements OnInit {
  private readonly api: CrmService = inject(CrmService);

  readonly lista = signal<Ejecutivo[]>([]);
  readonly libres = signal<AsesorLibre[]>([]);
  readonly ed = signal<EdEjecutivo | null>(null);
  readonly destino = signal<string>('');
  readonly mensaje = signal<string>('');
  readonly error = signal<string>('');

  /** Asesores sin ejecutivo, más el que ya está vinculado a este (para que aparezca seleccionado). */
  readonly opcionesAsesor = computed<AsesorLibre[]>(() => {
    const e = this.ed();
    const base = [...this.libres()];
    if (e?.asesorId && !base.some((x) => x.id === e.asesorId)) {
      const v = this.lista().find((x) => x.asesor_id === e.asesorId);
      base.push({ id: e.asesorId, nombre: v?.asesor_nombre ?? `Asesor ${e.asesorId}` });
    }
    return base;
  });

  readonly destinos = computed<Ejecutivo[]>(() => {
    const e = this.ed();
    return this.lista().filter((x) => x.activo && x.id !== e?.id);
  });

  ngOnInit(): void { this.cargar(); }

  private ok(t: string): void { this.error.set(''); this.mensaje.set(t); }
  private fallo(e: HttpErrorResponse): void { this.mensaje.set(''); this.error.set(this.msg(e)); }
  private falla(t: string): void { this.mensaje.set(''); this.error.set(t); }
  iniciales(n: string): string { return n.split(/\s+/).slice(0, 2).map((x) => x.charAt(0)).join('').toUpperCase(); }

  private desde(e: Ejecutivo): EdEjecutivo {
    return {
      id: e.id, nombre: e.nombre, correo: e.correo, telefono: e.telefono, color: e.color, activo: e.activo,
      recibeLeads: e.recibe_leads, asesorId: e.asesor_id, usuarioId: e.usuario_id, leadsAbiertos: e.leads_abiertos,
    };
  }

  /** abrirId: abre el editor de ese ejecutivo. Sin él, si el editor está abierto solo se refrescan sus datos de solo lectura. */
  cargar(abrirId?: number): void {
    this.api.asesoresLibres().subscribe({ next: (l) => this.libres.set(l), error: (e: HttpErrorResponse) => this.fallo(e) });
    this.api.ejecutivos().subscribe({
      next: (l) => {
        this.lista.set(l);
        const actual = this.ed();
        if (abrirId !== undefined) {
          const e = l.find((x) => x.id === abrirId);
          if (e) { this.destino.set(''); this.ed.set(this.desde(e)); }
        } else if (actual && actual.id !== null) {
          const e = l.find((x) => x.id === actual.id);
          if (e) this.ed.update((x) => (x ? { ...x, usuarioId: e.usuario_id, leadsAbiertos: e.leads_abiertos } : x));
        }
      },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  nuevo(): void {
    this.destino.set('');
    this.ed.set({ id: null, nombre: '', correo: '', telefono: '', color: '#0ea5e9', activo: true, recibeLeads: true, asesorId: null, usuarioId: null, leadsAbiertos: 0 });
  }

  editar(e: Ejecutivo): void { this.cargar(e.id); }
  cerrar(): void { this.ed.set(null); }
  setEd(c: Partial<EdEjecutivo>): void { this.ed.update((a) => (a ? { ...a, ...c } : a)); }

  guardar(): void {
    const a = this.ed();
    if (!a) return;
    if (a.nombre.trim().length < 2) { this.falla('Escribe el nombre del ejecutivo'); return; }
    const cuerpo = {
      nombre: a.nombre.trim(), correo: a.correo.trim(), telefono: a.telefono.trim(), color: a.color,
      activo: a.activo, recibe_leads: a.recibeLeads, asesor_id: a.asesorId,
    };
    if (a.id === null) {
      this.api.crearEjecutivo(cuerpo).subscribe({
        next: (r) => { this.ok('Ejecutivo creado. Ahora puedes darle acceso al CRM.'); this.cargar(r.id); },
        error: (e: HttpErrorResponse) => this.fallo(e),
      });
    } else {
      this.api.editarEjecutivo(a.id, cuerpo).subscribe({
        next: () => { this.ok('Datos guardados'); this.cargar(); },
        error: (e: HttpErrorResponse) => this.fallo(e),
      });
    }
  }

  darAcceso(): void {
    const a = this.ed();
    if (!a || a.id === null) return;
    if (!a.correo.trim()) { this.falla('Primero guarda el correo del ejecutivo: ahí llegará su invitación'); return; }
    this.api.darAccesoEjecutivo(a.id).subscribe({
      next: () => { this.ok(`Invitación enviada a ${a.correo.trim()}. Podrá crear su clave desde el enlace del correo.`); this.cargar(); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  quitarAcceso(): void {
    const a = this.ed();
    if (!a || a.id === null || !confirm(`¿Quitar el acceso de ${a.nombre}? Su sesión se cierra de inmediato si solo era ejecutivo.`)) return;
    this.api.quitarAccesoEjecutivo(a.id).subscribe({
      next: () => { this.ok('Acceso retirado'); this.cargar(); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  traspasar(): void {
    const a = this.ed();
    const d = this.destino();
    if (!a || a.id === null || d === '') return;
    const aId = d === '0' ? null : Number(d);
    const nombreDestino = aId === null ? 'sin asignar' : (this.lista().find((x) => x.id === aId)?.nombre ?? 'otro ejecutivo');
    if (!confirm(`¿Pasar los ${a.leadsAbiertos} leads abiertos de ${a.nombre} a: ${nombreDestino}?`)) return;
    this.api.traspasar(a.id, aId).subscribe({
      next: (r) => { this.destino.set(''); this.ok(`${r.traspasados} leads traspasados`); this.cargar(); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  borrar(): void {
    const a = this.ed();
    if (!a || a.id === null || !confirm(`¿Eliminar a ${a.nombre}?`)) return;
    this.api.borrarEjecutivo(a.id).subscribe({
      next: () => { this.cerrar(); this.ok('Ejecutivo eliminado'); this.cargar(); },
      error: (e: HttpErrorResponse) => this.fallo(e),
    });
  }

  private msg(e: HttpErrorResponse): string {
    const d = e.error?.detail;
    if (typeof d === 'string') return d;
    if (Array.isArray(d)) return 'Revisa los datos: hay campos vacíos o con formato inválido.';
    return 'No se pudo conectar con el servidor';
  }
}