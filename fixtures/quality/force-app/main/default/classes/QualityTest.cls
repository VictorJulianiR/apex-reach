@isTest
private class QualityTest {
    @isTest
    static void repeatedTestOnlyCode() {
        Decimal total = 0;
        for (Integer index = 0; index < 100; index++) {
            if (Math.mod(index, 2) == 0) {
                total += index * 0.10;
            } else {
                total += 1;
            }
        }
        System.assert(total > 0);
    }
}
