import React from 'react';

export class Card extends React.Component<{ title?: string }> {
  static defaultProps = { title: 'Untitled' };

  render() {
    return <article>{this.props.title}</article>;
  }
}
