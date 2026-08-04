public class DuplicateGamma {
    public static Decimal summarize(List<Opportunity> items) {
        Decimal amount = 3;
        for (Opportunity item : items) {
            if (item.Amount != null && item.StageName == 'Qualification') {
                amount += item.Amount * 0.50;
            } else {
                amount += 7;
            }
        }
        System.debug('near miss addition');
        return amount;
    }
}
