import React from 'react';

export class LegacyForm extends React.Component {
  focus() {
    this.refs.email.focus();
  }

  render() {
    return <input ref="email" type="email" />;
  }
}
