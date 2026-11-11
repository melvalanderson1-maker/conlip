import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { ESTILOS_ADMIN } from '../../shared/estilos-admin';
import { CrmPanelComponent } from './crm-panel.component';
import { CrmFlagService } from './crm.service';

@Component({
  selector: 'app-crm-admin',
  imports: [CrmPanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap">
      <header class="cab">
        <div>
          <span class="eyebrow">Comercial</span>
          <h2>CRM</h2>
          <p class="sub">Clientes potenciales, seguimiento y embudo de ventas de todo el equipo.</p>
        </div>
      </header>
      @if (crm.activo()) {
        <app-crm-panel [esAdmin]="true" />
      } @else {
        <section class="card">
          <h3>El CRM está apagado</h3>
          <p class="nota">Los leads se siguen guardando en segundo plano, así que no pierdes nada. Actívalo en Ventas → Ajustes → Funciones cuando quieran usarlo.</p>
          <div class="fila acciones"><button type="button" class="btn primary" (click)="irVentas()">Ir a Ventas → Ajustes</button></div>
        </section>
      }
    </div>
  `,
  styles: [ESTILOS_ADMIN],
})
export class CrmAdminPage {
  readonly crm: CrmFlagService = inject(CrmFlagService);
  private readonly router: Router = inject(Router);
  irVentas(): void { void this.router.navigate(['/ventas-admin']); }
}