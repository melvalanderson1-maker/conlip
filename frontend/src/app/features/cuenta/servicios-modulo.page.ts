import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MisServiciosComponent } from './mis-servicios.component';

const NOMBRES: Record<string, string> = { perucompras: 'Perú Compras', menor: 'Coti Menor', mayor: 'Coti Mayor' };

@Component({
  selector: 'app-servicios-modulo',
  imports: [MisServiciosComponent, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap">
      <header class="cab">
        <span class="eyebrow">{{ nombre }}</span>
        <h1>Servicios</h1>
        <p>Sigue el avance de lo que contrataste, agenda tus sesiones y revisa tu calendario.</p>
      </header>
      <app-mis-servicios [modulo]="modulo" [mostrarVacio]="true" />
      <p class="mas">¿Necesitas algo más? <a routerLink="/cuenta">Contrata otro servicio desde Mi cuenta</a>.</p>
    </div>
  `,
  styles: [`
    :host { display: block; color: #0f172a; }
    .wrap { max-width: 1180px; margin: 0 auto; padding: 24px; }
    .eyebrow { display: block; margin-bottom: 4px; color: #1d4ed8; font-size: .78rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    h1 { margin: 0; font-size: 1.7rem; letter-spacing: -.02em; } .cab p { margin: 6px 0 0; color: #5a6784; }
    .mas { margin: 26px 0 0; color: #5a6784; font-size: .9rem; } .mas a { color: #1d4ed8; font-weight: 600; }
  `],
})
export class ServiciosModuloPage {
  private readonly route: ActivatedRoute = inject(ActivatedRoute);  
  readonly modulo: string = (this.route.snapshot.data['modulo'] as string) ?? 'perucompras';
  readonly nombre: string = NOMBRES[this.modulo] ?? '';
}