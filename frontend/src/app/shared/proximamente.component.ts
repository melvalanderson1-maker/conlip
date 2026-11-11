import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';

@Component({
  selector: 'app-proximamente',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="box">
      <h2>{{ titulo() }}</h2>
      <p>{{ mensaje() }}</p>
    </div>
  `,
  styles: [`
    .box { padding: 48px 24px; text-align: center; color: #64748b; }
    h2 { margin: 0 0 8px; color: #0f172a; }
  `],
})
export class ProximamenteComponent {
  private readonly route: ActivatedRoute = inject(ActivatedRoute);
  readonly titulo = toSignal(this.route.data.pipe(map((d) => (d['titulo'] as string) ?? 'En construcción')), {
    initialValue: 'En construcción',
  });
  readonly mensaje = toSignal(
    this.route.data.pipe(map((d) => (d['mensaje'] as string) ?? 'Esta sección está en construcción.')),
    { initialValue: 'Esta sección está en construcción.' },
  );
}