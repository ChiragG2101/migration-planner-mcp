import ReactDOM from 'react-dom';
import { LegacyForm } from '../components/LegacyForm';

export function mountLegacyForm(el: HTMLElement) {
  ReactDOM.render(<LegacyForm />, el);
}
