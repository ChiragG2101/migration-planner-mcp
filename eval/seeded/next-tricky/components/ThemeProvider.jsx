import React from 'react';
import PropTypes from 'prop-types';

export class ThemeProvider extends React.Component {
  static childContextTypes = { theme: PropTypes.string };

  getChildContext() {
    return { theme: 'dark' };
  }

  render() {
    return this.props.children;
  }
}
