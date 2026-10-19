import importlib

import shop.utils
from . import utils
from .models import Order, total as order_total
from .plugins import stripe as stripe_plugin


def load(name):
    plugin = importlib.import_module("shop.plugins.stripe")
    other = importlib.import_module(name)
    return plugin, other


def view(request):
    order = Order()
    return order_total([order]), utils.slugify("x"), shop.utils.slugify("y")


def shadow(Order):
    return Order
