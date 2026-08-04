({
    load: function(component) {
        const action = component.get("c.invoked");
        $A.enqueueAction(action);
    }
})
