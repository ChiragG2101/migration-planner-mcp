Upgrading
=========

Breaking changes
----------------

``request.user`` is lazy
~~~~~~~~~~~~~~~~~~~~~~~~

The user is no longer loaded up front.

.. _removed-ugettext:

``ugettext`` removed
~~~~~~~~~~~~~~~~~~~~

Use ``gettext``.

.. code-block:: python

    # not a heading
    Removed APIs
    ------------

Other changes
-------------

* The default ``USE_L10N`` is ``True``.
* ``django.utils.timezone`` grows a helper.

Unlisted section
----------------

This heading is not configured.
